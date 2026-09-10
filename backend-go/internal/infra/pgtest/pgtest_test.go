package pgtest

// Unit coverage for the binary-directory discovery (issue #131): the env
// overrides win in their prescribed order, PATH is the last-resort source,
// and a miss is an actionable error naming every tried path — never a
// silent fallback to an install path that only exists in one sandbox.

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeBinDir lays down executable stand-ins for the postgres binaries.
// Nothing here RUNS a binary: PGBin only LookPaths, and verifyBinDir only
// stats — the fake files exist so resolution sees a real directory layout.
func fakeBinDir(t *testing.T, bins ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, bin := range bins {
		if err := os.WriteFile(filepath.Join(dir, bin), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatalf("write %s under %s: %v", bin, dir, err)
		}
	}
	return dir
}

func TestPGBinDiscovery(t *testing.T) {
	firstEnvDir := "/first/env/wins"
	secondEnvDir := "/second/env/fallback"

	t.Run("FUATILIA_TEST_PGBIN wins over the second env var and PATH", func(t *testing.T) {
		t.Setenv(EnvPGBin, firstEnvDir)
		t.Setenv(EnvPGBinDir, secondEnvDir)
		t.Setenv("PATH", fakeBinDir(t, "initdb", "pg_ctl", "postgres"))
		dir, err := PGBin()
		if err != nil {
			t.Fatalf("PGBin: %v", err)
		}
		if dir != firstEnvDir {
			t.Fatalf("PGBin = %q, want the FUATILIA_TEST_PGBIN value %q", dir, firstEnvDir)
		}
	})

	t.Run("FUATILIA_PG_BIN_DIR is the fallback (TS testutil + CI alignment)", func(t *testing.T) {
		t.Setenv(EnvPGBin, "")
		t.Setenv(EnvPGBinDir, secondEnvDir)
		t.Setenv("PATH", fakeBinDir(t, "initdb", "pg_ctl", "postgres"))
		dir, err := PGBin()
		if err != nil {
			t.Fatalf("PGBin: %v", err)
		}
		if dir != secondEnvDir {
			t.Fatalf("PGBin = %q, want the FUATILIA_PG_BIN_DIR value %q", dir, secondEnvDir)
		}
	})

	t.Run("whitespace-only FUATILIA_TEST_PGBIN falls through", func(t *testing.T) {
		t.Setenv(EnvPGBin, "   ")
		t.Setenv(EnvPGBinDir, secondEnvDir)
		t.Setenv("PATH", "")
		dir, err := PGBin()
		if err != nil {
			t.Fatalf("PGBin: %v", err)
		}
		if dir != secondEnvDir {
			t.Fatalf("PGBin = %q, want the FUATILIA_PG_BIN_DIR value %q", dir, secondEnvDir)
		}
	})

	t.Run("PATH discovery finds initdb and pg_ctl in one directory", func(t *testing.T) {
		t.Setenv(EnvPGBin, "")
		t.Setenv(EnvPGBinDir, "")
		onPath := fakeBinDir(t, "initdb", "pg_ctl", "postgres")
		t.Setenv("PATH", onPath)
		dir, err := PGBin()
		if err != nil {
			t.Fatalf("PGBin: %v", err)
		}
		if dir != onPath {
			t.Fatalf("PGBin = %q, want the PATH directory %q", dir, onPath)
		}
	})

	t.Run("PATH discovery prefers the first directory that holds the binaries", func(t *testing.T) {
		t.Setenv(EnvPGBin, "")
		t.Setenv(EnvPGBinDir, "")
		first := fakeBinDir(t, "initdb", "pg_ctl", "postgres")
		second := fakeBinDir(t, "initdb", "pg_ctl", "postgres")
		t.Setenv("PATH", first+string(os.PathListSeparator)+second)
		dir, err := PGBin()
		if err != nil {
			t.Fatalf("PGBin: %v", err)
		}
		if dir != first {
			t.Fatalf("PGBin = %q, want the first PATH hit %q", dir, first)
		}
	})

	t.Run("initdb and pg_ctl in DIFFERENT directories refuse", func(t *testing.T) {
		t.Setenv(EnvPGBin, "")
		t.Setenv(EnvPGBinDir, "")
		dirA := fakeBinDir(t, "initdb")
		dirB := fakeBinDir(t, "pg_ctl")
		t.Setenv("PATH", dirA+string(os.PathListSeparator)+dirB)
		_, err := PGBin()
		if err == nil {
			t.Fatalf("a PATH that scatters the binaries across directories must refuse")
		}
		for _, want := range []string{dirA, dirB, EnvPGBin, EnvPGBinDir} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error %q must name %q", err, want)
			}
		}
	})

	t.Run("nothing found → error names every tried path and the fix", func(t *testing.T) {
		t.Setenv(EnvPGBin, "")
		t.Setenv(EnvPGBinDir, "")
		bareDir := t.TempDir() // on PATH but holds no postgres binaries
		t.Setenv("PATH", bareDir)
		_, err := PGBin()
		if err == nil {
			t.Fatalf("no source at all must fail the run, got nil error")
		}
		for _, want := range []string{
			EnvPGBin,           // the override that wins
			EnvPGBinDir,        // the TS testutil + CI aligned name
			"(unset)",          // both env vars were tried and empty
			bareDir,            // every PATH entry tried is named
			"initdb", "pg_ctl", // what the PATH lookup looked for
			"/usr/lib/postgresql/16/bin", // the fix example
		} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("discovery error %q must name %q", err, want)
			}
		}
	})
}

// TestStartTempMissingBinariesIsActionable pins acceptance criterion 2: an
// env-resolved directory WITHOUT the postgres binaries fails with an error
// naming what is missing and the env vars that would point at a real
// PostgreSQL 16 installation.
func TestStartTempMissingBinariesIsActionable(t *testing.T) {
	t.Setenv(EnvPGBin, t.TempDir())
	cluster, stop, err := StartTemp(context.Background())
	if err == nil {
		stop()
		t.Fatalf("StartTemp from a binary-less directory must fail")
	}
	if cluster != nil {
		t.Fatalf("a failed StartTemp must return a nil cluster")
	}
	for _, want := range []string{"initdb", "pg_ctl", "postgres", EnvPGBin, EnvPGBinDir} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("StartTemp error %q must name %q", err, want)
		}
	}
}
