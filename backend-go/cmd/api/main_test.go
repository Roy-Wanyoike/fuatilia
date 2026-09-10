package main

// The boot-time gate for the OUTBOUND Daraja rail (issue #178): all five
// DARAJA_* variables bind the production STK wire, none disables it, a
// partial set refuses the boot (a half-configured rail would only fail on
// the first live push — config errors are deploy-time, never runtime).
// No network is touched: the client is constructed but never dialed here
// (its wire behavior is the daraja package's own test suite).

import (
	"strings"
	"testing"
)

const (
	validShortCode   = "412873"
	validPasskey     = "test-passkey-not-a-secret"
	validCallbackURL = "https://api.example.com/v1/callbacks/daraja/stk/result"
)

func railEnv(overrides map[string]string) func(string) string {
	base := map[string]string{
		"DARAJA_CONSUMER_KEY":      "test-consumer-key",
		"DARAJA_CONSUMER_SECRET":   "test-consumer-secret",
		"DARAJA_SHORT_CODE":        validShortCode,
		"DARAJA_PASSKEY":           validPasskey,
		"DARAJA_CALLBACK_BASE_URL": validCallbackURL,
	}
	for name, value := range overrides {
		base[name] = value
	}
	return func(name string) string { return base[name] }
}

func TestDarajaWireFromEnvDisabledWhenEveryVariableEmpty(t *testing.T) {
	wire, err := darajaWireFromEnv(railEnv(map[string]string{
		"DARAJA_CONSUMER_KEY":      "",
		"DARAJA_CONSUMER_SECRET":   "",
		"DARAJA_SHORT_CODE":        "",
		"DARAJA_PASSKEY":           "",
		"DARAJA_CALLBACK_BASE_URL": "",
	}))
	if err != nil {
		t.Fatalf("an empty rail config must boot disabled, got %v", err)
	}
	if wire != nil {
		t.Fatal("an empty rail config must bind no wire (ExecuteStkPush refuses with STK_WIRE_UNAVAILABLE)")
	}
}

func TestDarajaWireFromEnvPartialConfigRefusesBoot(t *testing.T) {
	for name := range map[string]struct{}{
		"DARAJA_CONSUMER_KEY":      {},
		"DARAJA_CONSUMER_SECRET":   {},
		"DARAJA_SHORT_CODE":        {},
		"DARAJA_PASSKEY":           {},
		"DARAJA_CALLBACK_BASE_URL": {},
	} {
		wire, err := darajaWireFromEnv(railEnv(map[string]string{name: ""}))
		if err == nil {
			t.Fatalf("%s missing: a partial rail config must refuse the boot", name)
		}
		if wire != nil {
			t.Fatalf("%s missing: no wire may bind on a partial config", name)
		}
		if !strings.Contains(err.Error(), "partial") || !strings.Contains(err.Error(), name) {
			t.Fatalf("%s missing: the error must name the contract (%v)", name, err)
		}
	}
}

func TestDarajaWireFromEnvFullConfigBindsTheAdapter(t *testing.T) {
	wire, err := darajaWireFromEnv(railEnv(nil))
	if err != nil {
		t.Fatalf("a complete rail config must boot: %v", err)
	}
	if wire == nil {
		t.Fatal("a complete rail config must bind the STK wire")
	}
}

func TestDarajaWireFromEnvAdapterValidationRunsAtBoot(t *testing.T) {
	// The merchant context is validated exactly as the adapter validates it:
	// a non-https callback URL is a boot failure, never a runtime surprise.
	wire, err := darajaWireFromEnv(railEnv(map[string]string{
		"DARAJA_CALLBACK_BASE_URL": "http://api.example.com/v1/callbacks/daraja/stk/result",
	}))
	if err == nil || wire != nil {
		t.Fatal("an http callback URL must refuse the boot (the rail delivers over https)")
	}
	if !strings.Contains(err.Error(), "CallBackURL") {
		t.Fatalf("the boot error must name the offending input: %v", err)
	}
}
