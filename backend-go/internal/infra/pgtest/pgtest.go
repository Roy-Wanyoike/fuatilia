// Package pgtest boots the REAL PostgreSQL 16.4 cluster the /v1 kernel's
// integration tests run against (issue #72 testing requirements; the same
// honest-boot discipline the outbox lane's testmain_test.go established).
//
// Two modes:
//
//   - RequireShared: the lane cluster already running on port 5435. The
//     package owns ONE dedicated database (fuatilia_api_test) so sibling
//     lanes on the same cluster are never touched; every test truncates the
//     rows it seeded (orgs CASCADE + the FK-free audit_events) in cleanup.
//     Migrations 0001–0016 are applied once under an advisory lock.
//
//   - StartTemp: a private initdb'd cluster on an ephemeral port (used by
//     the restart-resilience test, which must stop and start PostgreSQL
//     without disturbing anyone else).
//
// A companion boot script lives in internal/infra/testdata/boot-api-lane.sh
// for humans (same provisioning, same database).
package pgtest

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Environment overrides so the same helper runs in any sandbox layout.
//
// Honesty rule (the outbox lane's precedent): there is NO skip switch.
// Unreachable PostgreSQL or missing portable binaries return an ERROR that
// the caller FAILS the run with — the documented merge gate includes booting
// the cluster, and a silently skipped integration suite would fake the gate
// green.
const (
	// EnvPGBin is the Go lanes' original binary-directory override; it wins
	// over everything so existing scripts keep working.
	EnvPGBin = "FUATILIA_TEST_PGBIN"
	// EnvPGBinDir is the same binary-directory override the TypeScript
	// persistence testutil (src/adapters/persistence/pg/testutil.ts) and CI
	// set — one name serves both stacks (issue #131).
	EnvPGBinDir = "FUATILIA_PG_BIN_DIR"

	EnvPGPort = "FUATILIA_TEST_PGPORT"
	EnvPGData = "FUATILIA_TEST_PGDATA"

	defaultPGPort = "5435"
	defaultPGData = "/home/z/my-project/tools/pgdata-10-a"

	// SharedDBName is this lane's dedicated database on the shared cluster.
	SharedDBName = "fuatilia_api_test"
	// ApplicationDBName is the application lane's dedicated database on the
	// shared cluster (issue #178): the STK execute tests truncate at boot and
	// cleanup, and a second test binary doing the same against ONE database
	// would wipe the other's seed mid-run — so every truncating lane owns a
	// named database (RequireSharedFor) and the cluster is merely shared.
	ApplicationDBName = "fuatilia_app_test"
	// superuser is the trust-auth superuser the lane clusters run with.
	superuser = "postgres"

	// migrationCount is the expected db/migrations/*.sql file count; a drift
	// fails loudly instead of silently applying a partial schema. Bump in the
	// same change that adds db/migrations/0017+ (issue #178's Daraja lane).
	migrationCount = 17
)

// Host is the TCP host the lane clusters listen on.
const Host = "127.0.0.1"

// Cluster is a running PostgreSQL instance the tests share.
type Cluster struct {
	BinDir  string
	DataDir string
	Port    string
	// DBName is the migrated database tests run against.
	DBName string
	// Running reports whether this package started the cluster (StartTemp
	// clusters only — the shared lane cluster's lifecycle belongs to the
	// sandbox, never to a test).
	Running bool

	maintenanceDSN string
}

var (
	sharedOnce sync.Once
	sharedRef  *Cluster
	sharedErr  error
)

// DSN builds the kernel-facing DSN for a database on this cluster.
func (c *Cluster) DSN(database string) string {
	return fmt.Sprintf("postgres://%s@%s:%s/%s?sslmode=disable", superuser, Host, c.Port, database)
}

// RequireShared returns the shared lane cluster, FAILING with an error when
// the cluster is unreachable (the merge gate includes booting PostgreSQL —
// an unreachable database is a failing gate, never a silently green skip).
// Tests adapt: cluster, err := pgtest.RequireShared(ctx); err != nil { t.Fatal(err) }.
func RequireShared(ctx context.Context) (*Cluster, error) {
	bootCtx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()
	sharedOnce.Do(func() { sharedRef, sharedErr = startShared(bootCtx) })
	if sharedErr != nil {
		return nil, sharedErr
	}
	return sharedRef, nil
}

// RequireSharedFor is RequireShared with a per-lane database name: the same
// bootstrapped cluster, a DEDICATED migrated database (created on first use;
// migrations 0001–00NN applied under the same advisory lock). Two test
// binaries that truncate their lanes at boot/cleanup (transport +
// application, issue #178) each own a name, so the cluster is shared but no
// row space is — a truncate can never wipe another package's seed mid-run.
func RequireSharedFor(ctx context.Context, dbName string) (*Cluster, error) {
	cluster, err := RequireShared(ctx)
	if err != nil {
		return nil, err
	}
	if dbName == "" || dbName == SharedDBName {
		return cluster, nil
	}
	if err := cluster.ensureMigratedDBFor(ctx, dbName); err != nil {
		return nil, err
	}
	return cluster, nil
}

// TruncateAll wipes every row this lane seeded from the shared database
// (orgs CASCADE reaches every org-owned table; audit_events is the one
// org-rooted table without an FK to orgs). Called in each test's cleanup so
// tests never leak rows into each other.
func (c *Cluster) TruncateAll(ctx context.Context, database string) error {
	conn, err := pgx.Connect(ctx, c.DSN(database))
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `TRUNCATE audit_events, orgs CASCADE`)
	return err
}

// startShared reuses (or provisions) the lane cluster on FUATILIA_TEST_PGPORT
// (default 5435), then ensures the dedicated database exists with migrations
// 0001–0016 applied.
func startShared(ctx context.Context) (*Cluster, error) {
	binDir, err := PGBin()
	if err != nil {
		return nil, err
	}
	if err := verifyBinDir(binDir, "pg_ctl", "postgres"); err != nil {
		return nil, err
	}
	port := getenv(EnvPGPort, defaultPGPort)
	cluster := &Cluster{
		BinDir:         binDir,
		DataDir:        getenv(EnvPGData, filepath.Join(os.TempDir(), "fuatilia-testdata-unmanaged")),
		Port:           port,
		DBName:         SharedDBName,
		maintenanceDSN: fmt.Sprintf("postgres://%s@%s:%s/postgres?sslmode=disable", superuser, Host, port),
	}
	// The shared cluster is ALREADY RUNNING (lane bootstrap); only wait for
	// reachability — never start/stop a cluster other lanes may share.
	if err := awaitReachable(ctx, cluster.maintenanceDSN, 30*time.Second); err != nil {
		return nil, err
	}
	if err := cluster.ensureMigratedDB(ctx); err != nil {
		return nil, err
	}
	return cluster, nil
}

// StartTemp provisions a PRIVATE cluster: fresh data dir, initdb, start on
// an ephemeral port, dedicated database + migrations. The returned stop func
// shuts it down and removes the data dir. Used by tests that must restart
// PostgreSQL (call stop, Start again, prove the pool reconnects).
func StartTemp(ctx context.Context) (cluster *Cluster, stop func(), err error) {
	binDir, binErr := PGBin()
	if binErr != nil {
		return nil, nil, binErr
	}
	if err := verifyBinDir(binDir, "initdb", "pg_ctl", "postgres"); err != nil {
		return nil, nil, err
	}
	dataDir, err := os.MkdirTemp("", "fuatilia-pgtest-*")
	if err != nil {
		return nil, nil, err
	}
	port, err := freePort()
	if err != nil {
		_ = os.RemoveAll(dataDir)
		return nil, nil, err
	}
	// initdb provisions the fresh cluster: trust auth + the lane's
	// superuser, exactly the boot-api-lane.sh provisioning (issue #72's
	// committed setup script).
	if out, initErr := run(ctx, binDir, "initdb", "-D", dataDir, "-A", "trust", "-U", superuser); initErr != nil {
		_ = os.RemoveAll(dataDir)
		return nil, nil, fmt.Errorf("pgtest: initdb %s: %w: %s", dataDir, initErr, out)
	}
	cluster = &Cluster{
		BinDir:         binDir,
		DataDir:        dataDir,
		Port:           port,
		DBName:         SharedDBName,
		Running:        true,
		maintenanceDSN: fmt.Sprintf("postgres://%s@%s:%s/postgres?sslmode=disable", superuser, Host, port),
	}
	if err := cluster.Start(ctx); err != nil {
		_ = os.RemoveAll(dataDir)
		return nil, nil, fmt.Errorf("pgtest: start temp cluster: %w", err)
	}
	if err := cluster.ensureMigratedDB(ctx); err != nil {
		_ = cluster.Stop(context.Background())
		_ = os.RemoveAll(dataDir)
		return nil, nil, fmt.Errorf("pgtest: migrate temp cluster: %w", err)
	}
	stopped := false
	return cluster, func() {
		if !stopped {
			stopped = true
			_ = cluster.Stop(context.Background())
			_ = os.RemoveAll(dataDir)
		}
	}, nil
}

// Start boots the cluster (idempotent for an already-running one).
func (c *Cluster) Start(ctx context.Context) error {
	if _, err := run(ctx, c.BinDir, "pg_ctl", "-D", c.DataDir, "-o",
		fmt.Sprintf("-p %s -c listen_addresses=%s -k %s", c.Port, Host, c.DataDir),
		"-l", filepath.Join(c.DataDir, "server.log"), "-w", "-t", "60", "start"); err != nil {
		return err
	}
	c.Running = true
	return nil
}

// Stop shuts the cluster down (fast mode — no in-progress work expected).
func (c *Cluster) Stop(ctx context.Context) error {
	_, err := run(ctx, c.BinDir, "pg_ctl", "-D", c.DataDir, "-m", "fast", "-w", "stop")
	if err == nil {
		c.Running = false
	}
	return err
}

// ensureMigratedDB creates the dedicated database when missing and applies
// migrations 0001–0016 exactly once (per-cluster advisory lock so concurrent
// test binaries cannot double-apply).
func (c *Cluster) ensureMigratedDB(ctx context.Context) error {
	return c.ensureMigratedDBFor(ctx, c.DBName)
}

// ensureMigratedDBFor provisions (create + migrate once) any named database
// on this cluster — the RequireSharedFor machinery behind per-lane names.
func (c *Cluster) ensureMigratedDBFor(ctx context.Context, dbName string) error {
	conn, err := pgx.Connect(ctx, c.maintenanceDSN)
	if err != nil {
		return fmt.Errorf("pgtest: connect maintenance db: %w", err)
	}

	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, dbName).Scan(&exists); err != nil {
		conn.Close(ctx)
		return err
	}
	if !exists {
		if _, err := conn.Exec(ctx, fmt.Sprintf("CREATE DATABASE %s", dbName)); err != nil {
			conn.Close(ctx)
			return fmt.Errorf("pgtest: create database %s: %w", dbName, err)
		}
	}
	conn.Close(ctx)

	dbDSN := c.DSN(dbName)
	cfg, err := pgx.ParseConfig(dbDSN)
	if err != nil {
		return fmt.Errorf("pgtest: parse db dsn: %w", err)
	}
	// Migration files are multi-statement; the simple protocol executes the
	// file exactly as the reference migrate.cjs does.
	cfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	dbConn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("pgtest: connect %s: %w", dbName, err)
	}
	defer dbConn.Close(ctx)

	if _, err := dbConn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('fuatilia-api-testdata-migrations'))`); err != nil {
		return fmt.Errorf("pgtest: advisory lock: %w", err)
	}
	locked := true
	defer func() {
		if locked {
			_, _ = dbConn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext('fuatilia-api-testdata-migrations'))`)
		}
	}()

	var applied bool
	if err := dbConn.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_state')`).Scan(&applied); err != nil {
		return err
	}
	if applied {
		return nil
	}
	files, err := migrationFiles()
	if err != nil {
		return err
	}
	if len(files) != migrationCount {
		return fmt.Errorf("pgtest: expected %d migrations, found %d", migrationCount, len(files))
	}
	for _, name := range files {
		sql, err := os.ReadFile(filepath.Join(migrationsDir(), name))
		if err != nil {
			return err
		}
		tx, err := dbConn.Begin(ctx)
		if err != nil {
			return err
		}
		// Multi-statement file: simple protocol executes it exactly as the
		// reference migrate.cjs does (one transaction per file).
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("pgtest: migration %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	locked = false
	return nil
}

// RepoRoot walks up from the working directory until the db/migrations tree
// is found (go test runs with the package directory as CWD).
func RepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "db", "migrations", "0001_orgs.sql")); statErr == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("pgtest: db/migrations not found above %s", dir)
		}
		dir = parent
	}
}

func migrationsDir() string {
	root, err := RepoRoot()
	if err != nil {
		panic(err) // only reached from callers that already required the repo
	}
	return filepath.Join(root, "db", "migrations")
}

func migrationFiles() ([]string, error) {
	entries, err := os.ReadDir(migrationsDir())
	if err != nil {
		return nil, err
	}
	var files []string
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".sql") && !entry.IsDir() {
			files = append(files, name)
		}
	}
	sort.Strings(files)
	return files, nil
}

func awaitReachable(ctx context.Context, dsn string, within time.Duration) error {
	deadline := time.Now().Add(within)
	var lastErr error
	for {
		conn, err := pgx.Connect(ctx, dsn)
		if err == nil {
			return conn.Close(ctx)
		}
		lastErr = err
		if time.Now().After(deadline) {
			return fmt.Errorf("pgtest: cluster on %s unreachable: %w", dsn, lastErr)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func freePort() (string, error) {
	l, err := net.Listen("tcp", Host+":0")
	if err != nil {
		return "", err
	}
	defer l.Close()
	_, port, err := net.SplitHostPort(l.Addr().String())
	return port, err
}

func run(ctx context.Context, binDir, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, filepath.Join(binDir, name), args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// PGBin resolves the PostgreSQL binary directory the test clusters boot
// from. Discovery order — first hit wins (issue #131):
//
//  1. FUATILIA_TEST_PGBIN — the Go lanes' original override;
//  2. FUATILIA_PG_BIN_DIR — the name the TS persistence testutil
//     (src/adapters/persistence/pg/testutil.ts) and CI already set;
//  3. PATH — the directory holding both initdb and pg_ctl.
//
// No hardcoded install path survives (issue #131): the previous default
// named a directory that exists in exactly one sandbox, so every fresh
// clone failed `go test` deep inside pg_ctl. When nothing resolves, the
// error names every tried path plus the env vars that fix the run.
func PGBin() (string, error) {
	for _, env := range []string{EnvPGBin, EnvPGBinDir} {
		if dir := getenv(env, ""); dir != "" {
			return dir, nil
		}
	}
	initdb, initdbErr := exec.LookPath("initdb")
	pgctl, pgctlErr := exec.LookPath("pg_ctl")
	if initdbErr == nil && pgctlErr == nil {
		if dir := filepath.Dir(initdb); dir == filepath.Dir(pgctl) {
			return dir, nil
		}
		return "", fmt.Errorf("pgtest: PATH lookup found initdb in %s but pg_ctl in %s — one PostgreSQL installation holds both; set %s (or %s) to that directory",
			filepath.Dir(initdb), filepath.Dir(pgctl), EnvPGBin, EnvPGBinDir)
	}
	return "", fmt.Errorf(`pgtest: no PostgreSQL binary directory found. Tried, in order:
  %s: (unset)
  %s: (unset)
  PATH lookup of initdb: %s
  PATH lookup of pg_ctl: %s
set %s (or %s) to the directory holding initdb, pg_ctl and postgres — e.g. %s=/usr/lib/postgresql/16/bin — or add that directory to PATH (searched: %s)`,
		EnvPGBin, EnvPGBinDir,
		lookOutcome(initdb, initdbErr), lookOutcome(pgctl, pgctlErr),
		EnvPGBin, EnvPGBinDir, EnvPGBin, quotedPathList())
}

// lookOutcome renders one LookPath result for the discovery-failure error:
// the resolved path on a hit, the underlying error on a miss.
func lookOutcome(path string, err error) string {
	if err != nil {
		return fmt.Sprintf("not found (%v)", err)
	}
	return "found " + path
}

// quotedPathList renders $PATH as the explicit directory list a LookPath
// search tried, so the discovery-failure error names every tried path.
func quotedPathList() string {
	dirs := filepath.SplitList(os.Getenv("PATH"))
	if len(dirs) == 0 {
		return "(empty)"
	}
	quoted := make([]string, len(dirs))
	for i, dir := range dirs {
		quoted[i] = strconv.Quote(dir)
	}
	return strings.Join(quoted, ", ")
}

// verifyBinDir proves a resolved binary directory holds the binaries the
// caller needs; anything missing is an actionable error naming the env vars
// that would point at a real PostgreSQL 16 installation.
func verifyBinDir(binDir string, bins ...string) error {
	var missing []string
	for _, bin := range bins {
		if _, err := os.Stat(filepath.Join(binDir, bin)); err != nil {
			missing = append(missing, bin)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf("pgtest: %s missing under %s — the PostgreSQL 16 binaries are part of the merge gate: set %s (or %s) to the directory holding initdb, pg_ctl and postgres, or add it to PATH",
		strings.Join(missing, ", "), binDir, EnvPGBin, EnvPGBinDir)
}

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
