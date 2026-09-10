package scheduler

// Config tests: the FUATILIA_SCHED_* environment contract (config.go). The
// worker binary's only configuration surface — malformed values are refused
// with SCHED_CONFIG_INVALID (a scheduler that misread its cadence would be
// lying about its guarantees), unknown variables are ignored, and the
// late-fee policy is validated by the SAME pure validator the domain uses
// (late-fee.ts validateLateFeePolicy — see latefee_test.go for its table).

import (
	"testing"
	"time"
)

func getenvFrom(mapEnv map[string]string) func(string) string {
	return func(key string) string { return mapEnv[key] }
}

func TestConfigFromEnvDefaults(t *testing.T) {
	cfg, err := configFromEnv(getenvFrom(nil))
	if err != nil {
		t.Fatalf("empty environment: %v", err)
	}
	if cfg.DunningInterval != DefaultDunningInterval {
		t.Fatalf("dunning interval = %s, want default %s", cfg.DunningInterval, DefaultDunningInterval)
	}
	if cfg.LateFeeInterval != DefaultLateFeeInterval {
		t.Fatalf("late-fee interval = %s, want default %s", cfg.LateFeeInterval, DefaultLateFeeInterval)
	}
	if cfg.PlanInterval != DefaultPlanInterval {
		t.Fatalf("plan interval = %s, want default %s", cfg.PlanInterval, DefaultPlanInterval)
	}
	if cfg.AgingInterval != DefaultAgingInterval {
		t.Fatalf("aging interval = %s, want default %s", cfg.AgingInterval, DefaultAgingInterval)
	}
	if cfg.Batch != DefaultBatch {
		t.Fatalf("batch = %d, want default %d", cfg.Batch, DefaultBatch)
	}
	if cfg.LateFee.Kind != DefaultLateFeeKind || cfg.LateFee.PercentBps == nil || *cfg.LateFee.PercentBps != DefaultLateFeePercentBp {
		t.Fatalf("late-fee policy = %+v, want default percent %d bps", cfg.LateFee, DefaultLateFeePercentBp)
	}
	if cfg.LateFee.GraceDays != DefaultLateFeeGraceDays {
		t.Fatalf("grace days = %d, want default %d", cfg.LateFee.GraceDays, DefaultLateFeeGraceDays)
	}
}

func TestConfigFromEnvParsesEveryVariable(t *testing.T) {
	env := map[string]string{
		"FUATILIA_SCHED_DUNNING_INTERVAL":   "5m",
		"FUATILIA_SCHED_LATEFEE_INTERVAL":   "90s",
		"FUATILIA_SCHED_PLAN_INTERVAL":      "1h30m",
		"FUATILIA_SCHED_AGING_INTERVAL":     "12h",
		"FUATILIA_SCHED_BATCH":              "50",
		"FUATILIA_SCHED_LATEFEE_KIND":       "flat",
		"FUATILIA_SCHED_LATEFEE_FLAT_MINOR": "2500",
		"FUATILIA_SCHED_LATEFEE_CAP_MINOR":  "10000",
		"FUATILIA_SCHED_LATEFEE_GRACE_DAYS": "3",
		"FUATILIA_SCHED_COMPLETELY_UNKNOWN": "ignored",
	}
	cfg, err := configFromEnv(getenvFrom(env))
	if err != nil {
		t.Fatalf("valid environment: %v", err)
	}
	if cfg.DunningInterval != 5*time.Minute || cfg.LateFeeInterval != 90*time.Second ||
		cfg.PlanInterval != 90*time.Minute || cfg.AgingInterval != 12*time.Hour {
		t.Fatalf("intervals = %+v", cfg)
	}
	if cfg.Batch != 50 {
		t.Fatalf("batch = %d", cfg.Batch)
	}
	if cfg.LateFee.Kind != LateFeeFlat || cfg.LateFee.FlatMinor == nil || *cfg.LateFee.FlatMinor != 2500 {
		t.Fatalf("late-fee policy = %+v", cfg.LateFee)
	}
	if cfg.LateFee.CapMinor == nil || *cfg.LateFee.CapMinor != 10000 {
		t.Fatalf("cap = %v", cfg.LateFee.CapMinor)
	}
	if cfg.LateFee.GraceDays != 3 {
		t.Fatalf("grace = %d", cfg.LateFee.GraceDays)
	}
}

func TestConfigFromEnvMalformedValuesRefused(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		code string // SCHED_CONFIG_INVALID for parsed shapes; the pure validator's code for semantic policy refusals
	}{
		{"bad duration", map[string]string{"FUATILIA_SCHED_DUNNING_INTERVAL": "soon"}, CodeConfigInvalid},
		{"negative duration", map[string]string{"FUATILIA_SCHED_PLAN_INTERVAL": "-5m"}, CodeConfigInvalid},
		{"bad batch", map[string]string{"FUATILIA_SCHED_BATCH": "many"}, CodeConfigInvalid},
		{"negative batch", map[string]string{"FUATILIA_SCHED_BATCH": "-1"}, CodeConfigInvalid},
		{"bad bps shape", map[string]string{"FUATILIA_SCHED_LATEFEE_PERCENT_BPS": "1.5"}, CodeConfigInvalid},
		{"bad flat shape", map[string]string{"FUATILIA_SCHED_LATEFEE_FLAT_MINOR": "lots"}, CodeConfigInvalid},
		{"negative cap", map[string]string{"FUATILIA_SCHED_LATEFEE_CAP_MINOR": "-1"}, CodeLateFeePolicyCapInvalid},
		{"negative grace", map[string]string{"FUATILIA_SCHED_LATEFEE_GRACE_DAYS": "-2"}, CodeLateFeePolicyGraceInvalid},
		{"unknown kind", map[string]string{"FUATILIA_SCHED_LATEFEE_KIND": "exponential"}, CodeLateFeePolicyKindInvalid},
	}
	for _, tc := range cases {
		_, err := configFromEnv(getenvFrom(tc.env))
		if err == nil {
			t.Fatalf("%s: want %s, got a config", tc.name, tc.code)
		}
		if !hasCode(err, tc.code) {
			t.Fatalf("%s: want code %s, got %v", tc.name, tc.code, err)
		}
	}
}

// An explicit grace of 0 is a legal policy (no free days) and must not be
// confused with the unset default of 5.
func TestConfigFromEnvExplicitZeroGraceHonored(t *testing.T) {
	cfg, err := configFromEnv(getenvFrom(map[string]string{"FUATILIA_SCHED_LATEFEE_GRACE_DAYS": "0"}))
	if err != nil {
		t.Fatalf("explicit zero grace: %v", err)
	}
	if cfg.LateFee.GraceDays != 0 {
		t.Fatalf("grace = %d, want the explicit 0 (not the unset default)", cfg.LateFee.GraceDays)
	}
}

// The percent policy needs its bps; a flat policy needs its amount — the same
// pure refusals the domain validator raises (late-fee.ts validateLateFeePolicy).
func TestConfigFromEnvPolicyShapeRefused(t *testing.T) {
	_, err := configFromEnv(getenvFrom(map[string]string{
		"FUATILIA_SCHED_LATEFEE_KIND": "flat", // no FUATILIA_SCHED_LATEFEE_FLAT_MINOR
	}))
	if !hasCode(err, CodeLateFeePolicyFlatRequired) {
		t.Fatalf("flat without amount: want %s, got %v", CodeLateFeePolicyFlatRequired, err)
	}
	_, err = configFromEnv(getenvFrom(map[string]string{
		"FUATILIA_SCHED_LATEFEE_KIND":        "percent",
		"FUATILIA_SCHED_LATEFEE_PERCENT_BPS": "-5",
	}))
	if !hasCode(err, CodeLateFeePolicyBpsInvalid) {
		t.Fatalf("negative bps: want %s, got %v", CodeLateFeePolicyBpsInvalid, err)
	}
}

// A caller-provided Config with explicit values survives ResolveConfig
// untouched; zero fields fall back to the defaults.
func TestResolveConfigFillsDefaults(t *testing.T) {
	cfg, err := ResolveConfig(Config{Batch: 7})
	if err != nil {
		t.Fatalf("ResolveConfig: %v", err)
	}
	if cfg.DunningInterval != DefaultDunningInterval || cfg.Batch != 7 {
		t.Fatalf("cfg = %+v", cfg)
	}

	// An invalid policy is refused at startup with the TS refusal code.
	if _, err := ResolveConfig(Config{LateFee: LateFeePolicy{Kind: LateFeeFlat}}); !hasCode(err, CodeLateFeePolicyFlatRequired) {
		t.Fatalf("flat policy without amount: want %s, got %v", CodeLateFeePolicyFlatRequired, err)
	}
	// Negative intervals are refused.
	if _, err := ResolveConfig(Config{DunningInterval: -time.Minute}); !hasCode(err, CodeConfigInvalid) {
		t.Fatalf("negative interval: want %s, got %v", CodeConfigInvalid, err)
	}
}
