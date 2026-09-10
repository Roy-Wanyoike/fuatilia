package scheduler

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config configures the runner's job intervals, batch bounds and the late-fee
// policy the accrual job executes. Zero-valued intervals/batch fall back to
// the documented defaults; the late-fee policy is validated by the SAME pure
// validator the domain uses (ValidateLateFeePolicy — late-fee.ts parity), so
// a misconfigured policy is refused at startup with the TS refusal codes.
type Config struct {
	// DunningInterval / LateFeeInterval / PlanInterval / AgingInterval are the
	// tick cadences of the four jobs (FUATILIA_SCHED_*_INTERVAL).
	DunningInterval time.Duration
	LateFeeInterval time.Duration
	PlanInterval    time.Duration
	AgingInterval   time.Duration
	// Batch bounds one job cycle's scan (FUATILIA_SCHED_BATCH) — every job
	// progresses in bounded batches, so a huge backlog cannot monopolize a
	// cycle.
	Batch int
	// LateFee is the accrual policy the late-fee job executes for every
	// candidate receivable (FUATILIA_SCHED_LATEFEE_*).
	LateFee LateFeePolicy
}

// Defaults — the interval scheduler's shipped cadence and accrual policy.
const (
	DefaultDunningInterval = 15 * time.Minute
	DefaultLateFeeInterval = time.Hour
	DefaultPlanInterval    = 15 * time.Minute
	DefaultAgingInterval   = 24 * time.Hour
	DefaultBatch           = 200

	// Default late-fee policy: 1.5 % of the outstanding balance per accrual
	// period after a 5-day grace window (late-fee.spec.ts PERCENT_POLICY
	// neighbourhood; Kenyan B2B terms per review finding H4). Uncapped.
	DefaultLateFeeKind      = "percent"
	DefaultLateFeePercentBp = 150
	DefaultLateFeeGraceDays = 5
)

// LateFeeConfigInvalid reports a malformed FUATILIA_SCHED_LATEFEE_* value
// (parsed shapes only — semantic validation is ValidateLateFeePolicy's).
var LateFeeConfigInvalid = &Error{Code: CodeConfigInvalid, Message: "invalid FUATILIA_SCHED_LATEFEE_* configuration"}

// ResolveConfig fills zero fields with the documented defaults and validates
// the result. Exported so the worker binary can log the EFFECTIVE
// configuration at startup; New/ResolveConfig enforce exactly what it returns.
func ResolveConfig(cfg Config) (Config, error) {
	if cfg.DunningInterval == 0 {
		cfg.DunningInterval = DefaultDunningInterval
	}
	if cfg.LateFeeInterval == 0 {
		cfg.LateFeeInterval = DefaultLateFeeInterval
	}
	if cfg.PlanInterval == 0 {
		cfg.PlanInterval = DefaultPlanInterval
	}
	if cfg.AgingInterval == 0 {
		cfg.AgingInterval = DefaultAgingInterval
	}
	if cfg.Batch == 0 {
		cfg.Batch = DefaultBatch
	}
	if cfg.DunningInterval < 0 || cfg.LateFeeInterval < 0 || cfg.PlanInterval < 0 || cfg.AgingInterval < 0 {
		return cfg, schedErr(CodeConfigInvalid, "job intervals must be >= 0")
	}
	if cfg.Batch < 1 {
		return cfg, schedErr(CodeConfigInvalid, "batch must be >= 1, got %d", cfg.Batch)
	}
	if cfg.LateFee.Kind == "" {
		cfg.LateFee.Kind = DefaultLateFeeKind
	}
	// The shipped percent policy carries its default rate (150 bps); a flat
	// policy has no safe default amount — an explicit one is required
	// (FUATILIA_SCHED_LATEFEE_FLAT_MINOR) and ValidateLateFeePolicy refuses
	// its absence with LATE_FEE_POLICY_FLAT_REQUIRED.
	if cfg.LateFee.Kind == LateFeePercent && cfg.LateFee.PercentBps == nil {
		bps := DefaultLateFeePercentBp
		cfg.LateFee.PercentBps = &bps
	}
	if _, err := ValidateLateFeePolicy(cfg.LateFee); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// ConfigFromEnv builds a Config from the process environment (the worker
// binary's path). Unknown variables are ignored; malformed values are refused
// with SCHED_CONFIG_INVALID — a scheduler that misread its cadence would be
// lying about its guarantees.
//
//	FUATILIA_SCHED_DUNNING_INTERVAL   duration (default 15m)
//	FUATILIA_SCHED_LATEFEE_INTERVAL   duration (default 1h)
//	FUATILIA_SCHED_PLAN_INTERVAL      duration (default 15m)
//	FUATILIA_SCHED_AGING_INTERVAL     duration (default 24h)
//	FUATILIA_SCHED_BATCH              int      (default 200)
//	FUATILIA_SCHED_LATEFEE_KIND       flat|percent (default percent)
//	FUATILIA_SCHED_LATEFEE_PERCENT_BPS int     (default 150, kind percent)
//	FUATILIA_SCHED_LATEFEE_FLAT_MINOR int      (required, kind flat)
//	FUATILIA_SCHED_LATEFEE_CAP_MINOR  int      (optional)
//	FUATILIA_SCHED_LATEFEE_GRACE_DAYS int      (default 5)
func ConfigFromEnv() (Config, error) {
	return configFromEnv(os.Getenv)
}

func configFromEnv(getenv func(string) string) (Config, error) {
	var cfg Config
	var err error
	if cfg.DunningInterval, err = envDuration(getenv, "FUATILIA_SCHED_DUNNING_INTERVAL"); err != nil {
		return cfg, err
	}
	if cfg.LateFeeInterval, err = envDuration(getenv, "FUATILIA_SCHED_LATEFEE_INTERVAL"); err != nil {
		return cfg, err
	}
	if cfg.PlanInterval, err = envDuration(getenv, "FUATILIA_SCHED_PLAN_INTERVAL"); err != nil {
		return cfg, err
	}
	if cfg.AgingInterval, err = envDuration(getenv, "FUATILIA_SCHED_AGING_INTERVAL"); err != nil {
		return cfg, err
	}
	if cfg.Batch, err = envInt(getenv, "FUATILIA_SCHED_BATCH"); err != nil {
		return cfg, err
	}
	if kind := strings.TrimSpace(getenv("FUATILIA_SCHED_LATEFEE_KIND")); kind != "" {
		cfg.LateFee.Kind = LateFeePolicyKind(kind)
	}
	if cfg.LateFee.PercentBps, err = envIntPtr(getenv, "FUATILIA_SCHED_LATEFEE_PERCENT_BPS"); err != nil {
		return cfg, err
	}
	if cfg.LateFee.FlatMinor, err = envInt64Ptr(getenv, "FUATILIA_SCHED_LATEFEE_FLAT_MINOR"); err != nil {
		return cfg, err
	}
	if cfg.LateFee.CapMinor, err = envInt64Ptr(getenv, "FUATILIA_SCHED_LATEFEE_CAP_MINOR"); err != nil {
		return cfg, err
	}
	if v, err := envInt(getenv, "FUATILIA_SCHED_LATEFEE_GRACE_DAYS"); err != nil {
		return cfg, err
	} else if getenv("FUATILIA_SCHED_LATEFEE_GRACE_DAYS") != "" {
		cfg.LateFee.GraceDays = v
	} else {
		cfg.LateFee.GraceDays = DefaultLateFeeGraceDays
	}
	return ResolveConfig(cfg)
}

func envDuration(getenv func(string) string, key string) (time.Duration, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < 0 {
		return 0, schedErr(CodeConfigInvalid, "%s must be a non-negative duration, got %q", key, raw)
	}
	return d, nil
}

func envInt(getenv func(string) string, key string) (int, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, schedErr(CodeConfigInvalid, "%s must be an integer, got %q", key, raw)
	}
	return v, nil
}

func envIntPtr(getenv func(string) string, key string) (*int, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return nil, nil
	}
	v, err := envInt(getenv, key)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func envInt64Ptr(getenv func(string) string, key string) (*int64, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return nil, nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return nil, schedErr(CodeConfigInvalid, "%s must be an integer, got %q", key, raw)
	}
	return &v, nil
}
