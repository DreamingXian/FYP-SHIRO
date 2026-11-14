/*
 * =========================================================================================
 *   SHIRO firmware logic tests - runs on a PC, no board needed.
 *
 *   Compiles the same fall_detector.h, shiro_packet.h and pulse_estimator.h that go
 *   into the firmware and checks them against synthetic traces and against the
 *   pulse recordings of the bench measurements (tests/data).
 *
 *   Windows (Visual Studio C++ tools):   run_host_tests.bat
 *   Any system with g++ or clang++:      g++ -std=c++17 -Wall -Wextra host_tests.cpp -o host_tests && ./host_tests
 *   Run from the firmware/tests folder.
 * =========================================================================================
 */
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "../shiro_wristband_vitals/fall_detector.h"
#include "../shiro_wristband_vitals/pulse_estimator.h"
#include "../shiro_wristband_vitals/shiro_packet.h"
#include "../shiro_wristband_vitals/vitals_filter.h"

static int g_checks = 0;
static int g_failures = 0;
static const char* g_section = "";

#define CHECK(cond)                                                                      \
  do {                                                                                   \
    g_checks++;                                                                          \
    if (!(cond)) {                                                                       \
      g_failures++;                                                                      \
      std::printf("  FAIL [%s] line %d: %s\n", g_section, __LINE__, #cond);              \
    }                                                                                    \
  } while (0)

static void section(const char* name) {
  g_section = name;
  std::printf("- %s\n", name);
}

static bool nearly(float a, float b, float tolerance = 0.011f) { return std::fabs(a - b) <= tolerance; }

// ---------------------------------------------------------------------------
// Trace helpers: 50 Hz samples, 20 ms apart, exactly like the firmware loop
// ---------------------------------------------------------------------------
struct Trace {
  FallDetector detector;
  uint32_t t;
  int confirmations;

  explicit Trace(uint32_t start = 1000, const FallConfig& cfg = defaultFallConfig())
      : detector(cfg), t(start), confirmations(0) {}

  Trace& hold(float g, uint32_t durationMs) {
    for (uint32_t elapsed = 0; elapsed < durationMs; elapsed += 20) sample(g);
    return *this;
  }
  Trace& sample(float g) {
    if (detector.update(g, t)) confirmations++;
    t += 20;
    return *this;
  }
  // Sinusoid around 1 g: amplitude in g, period in ms
  Trace& swing(float amplitude, uint32_t periodMs, uint32_t durationMs) {
    for (uint32_t elapsed = 0; elapsed < durationMs; elapsed += 20) {
      const float phase = 6.2831853f * (float)(elapsed % periodMs) / (float)periodMs;
      sample(1.0f + amplitude * std::sin(phase));
    }
    return *this;
  }
  // Canonical fall: rest, free-fall, impact, stillness
  Trace& fall(uint32_t freefallMs = 300, float freefallG = 0.15f, float impactG = 4.0f, float restG = 1.02f) {
    return hold(1.0f, 1000).hold(freefallG, freefallMs).hold(impactG, 40).hold(restG, 3000);
  }
};

// ---------------------------------------------------------------------------
static void testSelfTest() {
  section("built-in self-test");
  const FallSelfTestResult r = runFallSelfTest();
  CHECK(r.fallDetected);
  CHECK(r.shortDipIgnored);
  CHECK(r.movementIgnored);
  CHECK(r.passed());
}

static void testCanonicalFall() {
  section("a fall is confirmed once, with its measurements");
  Trace tr;
  tr.fall();
  CHECK(tr.confirmations == 1);
  CHECK(tr.detector.emergency());
  CHECK(tr.detector.eventCounter() == 1);
  CHECK(nearly(tr.detector.peakImpactG(), 4.0f));
  CHECK(nearly(tr.detector.minFreefallG(), 0.15f));
  CHECK(tr.detector.stillnessG() < 0.20f);
  CHECK(tr.detector.stillnessG() > 0.0f);
}

static void testFreefallDuration() {
  section("free-fall must last at least 150 ms");
  {
    Trace tr;  // 140 ms: 7 samples
    tr.fall(140);
    CHECK(tr.confirmations == 0);
    CHECK(!tr.detector.emergency());
  }
  {
    Trace tr;  // 160 ms: 8 samples
    tr.fall(160);
    CHECK(tr.confirmations == 1);
  }
  {
    Trace tr;  // one single low sample, as the old firmware accepted
    tr.hold(1.0f, 1000).sample(0.3f).hold(4.0f, 40).hold(1.0f, 3000);
    CHECK(tr.confirmations == 0);
  }
}

static void testFreefallThreshold() {
  section("free-fall threshold is 0.50 g, exclusive");
  {
    Trace tr;
    tr.fall(300, 0.50f);  // exactly at the threshold is not free-fall
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;
    tr.fall(300, 0.49f);
    CHECK(tr.confirmations == 1);
  }
}

static void testImpactThreshold() {
  section("impact threshold is 2.50 g, exclusive");
  {
    Trace tr;
    tr.fall(300, 0.15f, 2.50f);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;
    tr.fall(300, 0.15f, 2.51f);
    CHECK(tr.confirmations == 1);
    CHECK(nearly(tr.detector.peakImpactG(), 2.51f));
  }
}

static void testImpactWindow() {
  section("impact must follow the free-fall within 500 ms");
  {
    Trace tr;  // 480 ms of normal gravity between free-fall and impact
    tr.hold(1.0f, 1000).hold(0.15f, 300).hold(1.0f, 480).hold(4.0f, 40).hold(1.0f, 3000);
    CHECK(tr.confirmations == 1);
  }
  {
    Trace tr;  // 600 ms: too late, unrelated knock
    tr.hold(1.0f, 1000).hold(0.15f, 300).hold(1.0f, 600).hold(4.0f, 40).hold(1.0f, 3000);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;  // free-fall with no impact at all (wristband lowered gently)
    tr.hold(1.0f, 1000).hold(0.15f, 300).hold(1.0f, 5000);
    CHECK(tr.confirmations == 0);
    CHECK(tr.detector.currentPhase() == FALL_PHASE_MONITORING);
  }
}

static void testStillness() {
  section("post-impact stillness: mean motion below 0.20 g for 2 s, after 0.5 s settling");
  {
    Trace tr;  // lying still but breathing/trembling slightly
    tr.hold(1.0f, 1000).hold(0.15f, 300).hold(4.0f, 40).swing(0.10f, 400, 3000);
    CHECK(tr.confirmations == 1);
  }
  {
    Trace tr;  // gets up and walks away: clear movement
    tr.hold(1.0f, 1000).hold(0.15f, 300).hold(4.0f, 40).swing(0.60f, 400, 3000);
    CHECK(tr.confirmations == 0);
    CHECK(!tr.detector.emergency());
  }
  {
    Trace tr;  // not confirmed before settling plus the full 2 s have been observed
    tr.hold(1.0f, 1000).hold(0.15f, 300).hold(4.0f, 40).hold(1.0f, 2300);
    CHECK(tr.confirmations == 0);
    tr.hold(1.0f, 400);
    CHECK(tr.confirmations == 1);
  }
}

static void testImpactSettling() {
  section("the impact shock is not counted as post-impact movement");
  {
    // Bench finding of 14 Nov 2026: a hard landing lasts several samples and rings.
    // Averaged into the stillness window this alone gave 0.36 g and hid the fall.
    Trace tr;
    tr.hold(1.0f, 1000).hold(0.08f, 300).hold(13.0f, 80);
    for (int i = 0; i < 8; i++) tr.sample(i % 2 == 0 ? 2.2f : 0.3f);  // 160 ms of ringing
    tr.hold(1.02f, 3000);
    CHECK(tr.confirmations == 1);
    CHECK(nearly(tr.detector.peakImpactG(), 13.0f));
    CHECK(tr.detector.stillnessG() < 0.05f);  // reports the lying still, not the landing
  }
  {
    Trace tr;  // the highest value of the impact is kept even when it is not the first sample
    tr.hold(1.0f, 1000).hold(0.15f, 300).sample(3.0f).sample(9.0f).sample(5.0f).hold(1.0f, 3000);
    CHECK(tr.confirmations == 1);
    CHECK(nearly(tr.detector.peakImpactG(), 9.0f));
  }
  {
    Trace tr;  // still for the settling time only, then gets up: not a fall alarm
    tr.hold(1.0f, 1000).hold(0.15f, 300).hold(4.0f, 40).hold(1.0f, 500).swing(0.60f, 400, 3000);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;  // an object that keeps bouncing or rolling after landing is still rejected
    tr.hold(1.0f, 1000).hold(0.10f, 300).hold(6.0f, 40);
    for (int i = 0; i < 5; i++) tr.hold(0.3f, 200).hold(3.5f, 40).hold(1.0f, 300);
    tr.swing(0.40f, 300, 2000);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;  // the alarm is raised 2.5 s after the impact, not earlier and not later
    tr.hold(1.0f, 1000).hold(0.15f, 300);
    const uint32_t impactAt = tr.t;
    tr.hold(4.0f, 40);
    while (tr.confirmations == 0 && tr.t < impactAt + 10000) tr.sample(1.0f);
    CHECK(tr.confirmations == 1);
    CHECK(tr.t - 20 - impactAt == 2500);
  }
}

static void testHoldAndCounter() {
  section("alert hold, fall counter and repeated falls");
  Trace tr;
  tr.detector.seedCounter(254);
  tr.fall();
  CHECK(tr.detector.eventCounter() == 255);

  // During the 45 s hold nothing new is confirmed, even if the pattern repeats
  tr.fall();
  CHECK(tr.confirmations == 1);
  CHECK(tr.detector.emergency());

  tr.hold(1.0f, 45000);
  CHECK(!tr.detector.emergency());
  CHECK(tr.detector.eventCounter() == 255);          // the counter keeps its value after the hold
  CHECK(nearly(tr.detector.peakImpactG(), 4.0f));    // and so do the measurements

  tr.fall(300, 0.10f, 5.5f);
  CHECK(tr.confirmations == 2);
  CHECK(tr.detector.eventCounter() == 0);            // wraps from 255 to 0
  CHECK(nearly(tr.detector.peakImpactG(), 5.5f));
  CHECK(nearly(tr.detector.minFreefallG(), 0.10f));
}

static void testHoldEndsWithoutSamples() {
  section("the hold also ends while the sensor delivers nothing");
  Trace tr;
  tr.fall();
  CHECK(tr.detector.emergency());
  tr.detector.service(tr.t + 44000);
  CHECK(tr.detector.emergency());
  tr.detector.service(tr.t + 46000);
  CHECK(!tr.detector.emergency());
}

static void testClockWrap() {
  section("millis() wrapping around during a fall");
  Trace tr(0xFFFFFFFFu - 1500u);  // the 32-bit clock overflows in the middle of the trace
  tr.fall();
  CHECK(tr.confirmations == 1);
  CHECK(tr.t < 0x10000u);         // proves the clock really wrapped
}

static void testBadSamples() {
  section("invalid samples and sensor loss");
  {
    Trace tr;
    tr.hold(1.0f, 1000);
    tr.sample(std::nanf("")).sample(-1.0f);
    CHECK(tr.detector.currentPhase() == FALL_PHASE_MONITORING);
    tr.fall();
    CHECK(tr.confirmations == 1);
  }
  {
    Trace tr;  // sensor lost in the middle of an evaluation
    tr.hold(1.0f, 1000).hold(0.15f, 300).hold(4.0f, 40);
    CHECK(tr.detector.currentPhase() == FALL_PHASE_POST_IMPACT);
    tr.detector.cancelPending();
    CHECK(tr.detector.currentPhase() == FALL_PHASE_MONITORING);
    tr.hold(1.0f, 3000);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;  // cancelPending must not clear a confirmed fall
    tr.fall();
    tr.detector.cancelPending();
    CHECK(tr.detector.emergency());
  }
}

static void testEverydayActivities() {
  section("everyday activities do not raise a fall");
  {
    Trace tr;  // vigorous arm swinging for one minute
    tr.swing(0.45f, 600, 60000);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;  // hand clap: sharp impact, no free-fall before it
    for (int i = 0; i < 10; i++) tr.hold(1.0f, 800).hold(6.0f, 20).hold(1.0f, 400);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;  // sitting down hard: short dip, moderate bump
    for (int i = 0; i < 10; i++) tr.hold(1.0f, 1500).hold(0.40f, 80).hold(2.9f, 40).hold(1.0f, 3000);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;  // jump and keep walking: free-fall and impact, but no stillness
    tr.hold(1.0f, 1000).hold(0.20f, 260).hold(3.6f, 40).swing(0.50f, 500, 4000);
    CHECK(tr.confirmations == 0);
  }
  {
    Trace tr;  // wristband put down on a table: tiny knock at rest
    tr.hold(1.0f, 1000).hold(1.8f, 20).hold(1.0f, 5000);
    CHECK(tr.confirmations == 0);
  }
}

// ---------------------------------------------------------------------------
static shiro::Telemetry sampleTelemetry() {
  shiro::Telemetry t;
  t.bpm = 72;
  t.spo2 = 98;
  t.motion = shiro::MOTION_WALKING;
  t.battery = 87;
  t.charging = false;
  t.contact = true;
  t.fall = false;
  t.active = true;
  t.imuFault = false;
  t.ppgFault = false;
  t.g = 1.23f;
  t.fallSeq = 200;
  t.impactG = 4.37f;
  t.freefallG = 0.12f;
  t.stillG = 0.06f;
  return t;
}

static void testPacketLayout() {
  section("packet v2: exact byte layout");
  uint8_t p[shiro::PACKET_V2_LENGTH];
  shiro::encodePacketV2(sampleTelemetry(), p);

  // The reference packet documented in docs/protocol.md
  const uint8_t expected[shiro::PACKET_V2_LENGTH] = {
      0x53, 0x48, 0x02, 72, 98, 2, 87, 0x0A, 0x00, 0x7B, 200, 0x01, 0xB5, 12, 6};
  CHECK(std::memcmp(p, expected, sizeof(expected)) == 0);
  CHECK(shiro::PACKET_V2_LENGTH == 15);
  // Flags (3 bytes) + manufacturer data header (2 bytes) + packet must fit a 31-byte advertisement
  CHECK(3 + 2 + shiro::PACKET_V2_LENGTH <= 31);
}

static void testPacketRoundTrip() {
  section("packet v2: encode then decode gives the same values");
  shiro::Telemetry in = sampleTelemetry();
  in.charging = true;
  in.imuFault = true;
  in.ppgFault = true;
  uint8_t p[shiro::PACKET_V2_LENGTH];
  shiro::encodePacketV2(in, p);

  shiro::Telemetry out;
  CHECK(shiro::decodePacket(p, sizeof(p), out) == shiro::DECODE_OK);
  CHECK(out.bpm == 72 && out.spo2 == 98 && out.battery == 87);
  CHECK(out.motion == shiro::MOTION_WALKING);
  CHECK(out.charging && out.contact && out.active && out.imuFault && out.ppgFault);
  CHECK(!out.fall);
  CHECK(nearly(out.g, 1.23f));
  CHECK(out.fallSeq == 200);
  CHECK(nearly(out.impactG, 4.37f));
  CHECK(nearly(out.freefallG, 0.12f));
  CHECK(nearly(out.stillG, 0.06f));
}

static void testPacketFallFlag() {
  section("packet v2: the fall flag always reports FALL_EMERGENCY");
  shiro::Telemetry in = sampleTelemetry();
  in.fall = true;
  in.motion = shiro::MOTION_STATIONARY;
  uint8_t p[shiro::PACKET_V2_LENGTH];
  shiro::encodePacketV2(in, p);
  CHECK(p[5] == shiro::MOTION_FALL_EMERGENCY);
  CHECK((p[7] & shiro::FLAG_FALL) != 0);

  shiro::Telemetry out;
  CHECK(shiro::decodePacket(p, sizeof(p), out) == shiro::DECODE_OK);
  CHECK(out.fall);
  CHECK(std::strcmp(shiro::motionName(out.motion), "FALL_EMERGENCY") == 0);
}

static void testPacketLimits() {
  section("packet v2: out-of-range values are limited, never wrapped");
  shiro::Telemetry in = sampleTelemetry();
  in.g = 27.71f;         // the largest value a +/-16 g sensor can report
  in.impactG = 1000.0f;  // absurd: must saturate
  in.freefallG = 9.0f;   // one byte: saturates at 2.55
  in.stillG = std::nanf("");
  uint8_t p[shiro::PACKET_V2_LENGTH];
  shiro::encodePacketV2(in, p);

  shiro::Telemetry out;
  CHECK(shiro::decodePacket(p, sizeof(p), out) == shiro::DECODE_OK);
  CHECK(nearly(out.g, 27.71f));
  CHECK(nearly(out.impactG, 655.35f));
  CHECK(nearly(out.freefallG, 2.55f));
  CHECK(out.stillG == 0.0f);

  in.g = -3.0f;
  shiro::encodePacketV2(in, p);
  CHECK(p[8] == 0 && p[9] == 0);

  CHECK(shiro::clampPercent(-5) == 0);
  CHECK(shiro::clampPercent(140) == 100);
  CHECK(shiro::clampPercent(63) == 63);
}

static void testPacketRejection() {
  section("packet: foreign, old and damaged packets are rejected");
  shiro::Telemetry out;
  uint8_t good[shiro::PACKET_V2_LENGTH];
  shiro::encodePacketV2(sampleTelemetry(), good);

  // Another manufacturer's data
  const uint8_t apple[] = {0x4C, 0x00, 0x02, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  CHECK(shiro::decodePacket(apple, sizeof(apple), out) == shiro::DECODE_NOT_SHIRO);
  CHECK(shiro::decodePacket(NULL, 15, out) == shiro::DECODE_NOT_SHIRO);
  CHECK(shiro::decodePacket(good, 1, out) == shiro::DECODE_NOT_SHIRO);

  // Protocol 1: 9 bytes, heart rate where the version byte now is
  const uint8_t v1[] = {0x53, 0x48, 72, 98, 0, 87, 0x02, 0x00, 0x64};
  CHECK(shiro::decodePacket(v1, sizeof(v1), out) == shiro::DECODE_BAD_VERSION);

  // A future version must not be half-understood
  uint8_t v3[shiro::PACKET_V2_LENGTH];
  std::memcpy(v3, good, sizeof(good));
  v3[2] = 3;
  CHECK(shiro::decodePacket(v3, sizeof(v3), out) == shiro::DECODE_BAD_VERSION);

  // Truncated protocol 2 packet
  CHECK(shiro::decodePacket(good, shiro::PACKET_V2_LENGTH - 1, out) == shiro::DECODE_TOO_SHORT);

  // An unknown motion code falls back to STATIONARY
  uint8_t odd[shiro::PACKET_V2_LENGTH];
  std::memcpy(odd, good, sizeof(good));
  odd[5] = 9;
  CHECK(shiro::decodePacket(odd, sizeof(odd), out) == shiro::DECODE_OK);
  CHECK(out.motion == shiro::MOTION_STATIONARY);
}

static void testVitalsFilter() {
  section("vitals: accepted range");
  CHECK(!isValidBpm(29.9f) && isValidBpm(30.0f) && isValidBpm(220.0f) && !isValidBpm(220.1f));
  CHECK(!isValidSpo2(69.9f) && isValidSpo2(70.0f) && isValidSpo2(100.0f) && !isValidSpo2(100.1f));
  CHECK(isValidBpm(35.0f));   // bradycardia must not be discarded
  CHECK(isValidSpo2(78.0f));  // nor desaturation
}

static std::string readFile(const char* path) {
  std::ifstream in(path, std::ios::binary);
  std::string content((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  // Line endings differ between checkouts and do not matter
  std::string normalised;
  for (char c : content) {
    if (c != '\r') normalised += c;
  }
  return normalised;
}

static void testPacketHeaderCopies() {
  section("both copies of shiro_packet.h are identical");
  const std::string wristband = readFile("../shiro_wristband_vitals/shiro_packet.h");
  const std::string anchor = readFile("../shiro_anchor_node/shiro_packet.h");
  CHECK(!wristband.empty());
  CHECK(!anchor.empty());
  CHECK(wristband == anchor);
}

// ---------------------------------------------------------------------------
// Pulse estimator (heart rate and SpO2 from the raw sensor signal)
// ---------------------------------------------------------------------------
struct PulseRun {
  std::vector<int> bpm;    // reported rate after every estimate (one per second), 0 = no reading
  std::vector<int> spo2;
  int firstShownSample = -1;
  int samples = 0;

  int shown() const {
    int n = 0;
    for (int v : bpm) n += (v != 0);
    return n;
  }
  int last() const { return bpm.empty() ? 0 : bpm.back(); }
  // every reported rate lies between lo and hi
  bool allWithin(int lo, int hi) const {
    for (int v : bpm) {
      if (v != 0 && (v < lo || v > hi)) return false;
    }
    return true;
  }
  bool spo2Within(int lo, int hi) const {
    for (int v : spo2) {
      if (v != 0 && (v < lo || v > hi)) return false;
    }
    return true;
  }
  int spo2Shown() const {
    int n = 0;
    for (int v : spo2) n += (v != 0);
    return n;
  }
};

static void feedPulse(PulseEstimator& p, uint32_t ir, uint32_t red, PulseRun& run) {
  run.samples++;
  if (!p.addSample(ir, red)) return;
  run.bpm.push_back(p.bpm());
  run.spo2.push_back(p.spo2());
  if (p.bpm() != 0 && run.firstShownSample < 0) run.firstShownSample = run.samples;
}

// Repeatable noise, roughly normal with standard deviation 1
struct TestNoise {
  uint32_t state;
  explicit TestNoise(uint32_t seed) : state(seed) {}
  double next() {
    double sum = 0;
    for (int i = 0; i < 12; i++) {
      state = state * 1103515245u + 12345u;
      sum += ((state >> 8) & 0xFFFF) / 65536.0;
    }
    return sum - 6.0;
  }
};

// A pulse wave with harmonics on a slowly breathing level, as the sensor would deliver it.
// "ratio" is R of the SpO2 formula: (red pulse / red level) / (infrared pulse / infrared level).
struct PulseSignal {
  double bpm;
  double amplitude = 100;   // sensor counts
  double noise = 10;
  double drift = 200;       // breathing, 15 per minute
  double ratio = 0.5;
  double level = 130000;
};

static void playPulse(PulseEstimator& p, PulseRun& run, const PulseSignal& s, int seconds, uint32_t seed = 7) {
  const double kPi = 3.14159265358979323846;
  TestNoise noise(seed);
  for (int i = 0; i < seconds * 100; i++) {
    const double t = i / 100.0;
    const double phase = 2.0 * kPi * (s.bpm / 60.0) * t;
    const double pulse = std::sin(phase) + 0.5 * std::sin(2 * phase + 0.8) + 0.25 * std::sin(3 * phase + 1.6);
    const double wander = s.drift * std::sin(2.0 * kPi * 0.25 * t);
    const double ir = s.level + s.amplitude * pulse + wander + s.noise * noise.next();
    const double red = s.level * 0.75 + s.amplitude * s.ratio * 0.75 * pulse + wander * 0.7 + s.noise * noise.next();
    feedPulse(p, (uint32_t)(ir + 0.5), (uint32_t)(red + 0.5), run);
  }
}

static PulseRun runPulse(const PulseSignal& s, int seconds, uint32_t seed = 7) {
  PulseEstimator p;
  PulseRun run;
  playPulse(p, run, s, seconds, seed);
  return run;
}

static void testPulseRange() {
  section("pulse: every rate from 30 to 220 BPM is measured");
  const int rates[] = {30, 35, 40, 48, 60, 75, 93, 120, 150, 180, 200, 220};
  for (int rate : rates) {
    PulseSignal s;
    s.bpm = rate;
    const PulseRun run = runPulse(s, 40);
    CHECK(run.shown() >= 25);                       // 30 estimates in 40 s, the first after 10 s
    CHECK(run.allWithin(rate - 1, rate + 1));
    CHECK(run.firstShownSample > 0 && run.firstShownSample <= 1400);   // first value within 14 s
  }

  // The reported range is the range of the packet and of the edge server
  const PulseConfig cfg = defaultPulseConfig();
  CHECK(cfg.validMinBpm == (uint8_t)BPM_VALID_MIN && cfg.validMaxBpm == (uint8_t)BPM_VALID_MAX);
}

static void testPulseWeakSignal() {
  section("pulse: a weak pulse on a breathing level is not pulled upwards");
  // Design finding: with a weaker high-pass filter, breathing lifted the short lags of the
  // autocorrelation and a weak pulse of 160 was reported as 177 with full confidence.
  const int rates[] = {93, 130, 160, 190};
  for (int rate : rates) {
    for (uint32_t seed = 1; seed <= 5; seed++) {
      PulseSignal s;
      s.bpm = rate;
      s.amplitude = 15;
      const PulseRun run = runPulse(s, 40, seed * 101);
      CHECK(run.shown() >= 20);
      CHECK(run.allWithin(rate - 3, rate + 3));
    }
  }
  // Slow and weak: it may take longer or stay unknown, but it must not be wrong
  PulseSignal slow;
  slow.bpm = 45;
  slow.amplitude = 15;
  CHECK(runPulse(slow, 40).allWithin(42, 48));
}

static void testPulseNoReading() {
  section("pulse: no reading without a pulse");
  {
    PulseSignal s;
    s.bpm = 93;
    s.amplitude = 0;
    s.noise = 30;
    CHECK(runPulse(s, 60).shown() == 0);            // noise only
    s.noise = 20;
    s.drift = 2000;
    CHECK(runPulse(s, 60).shown() == 0);            // breathing or slow movement only
  }
  {
    // Movement: the level jumps several times a second
    PulseEstimator p;
    PulseRun run;
    TestNoise noise(3);
    for (int i = 0; i < 6000; i++) {
      const int stepNo = (i / 137) % 5;
      feedPulse(p, (uint32_t)(130000 + stepNo * 900 + 20 * noise.next()), (uint32_t)(97000 + stepNo * 700 + 20 * noise.next()), run);
    }
    CHECK(run.shown() == 0);
  }
  {
    PulseEstimator p;
    PulseRun run;
    for (int i = 0; i < 6000; i++) feedPulse(p, 262143, 262143, run);   // sensor at its ceiling
    CHECK(run.bpm.empty() && p.bpm() == 0 && p.spo2() == 0);
  }
  {
    PulseEstimator p;
    PulseRun run;
    for (int i = 0; i < 6000; i++) feedPulse(p, 3000, 2500, run);       // no skin
    CHECK(run.bpm.empty() && p.bpm() == 0 && p.spo2() == 0);
  }
}

static void testPulseWithdrawal() {
  section("pulse: a value is withdrawn when the pulse is gone");
  PulseSignal good;
  good.bpm = 80;
  {
    // Pulse, then the same level without a pulse (sensor slipped)
    PulseEstimator p;
    PulseRun run;
    playPulse(p, run, good, 30);
    CHECK(run.last() == 80 || run.last() == 79 || run.last() == 81);
    PulseSignal flat = good;
    flat.amplitude = 0;
    PulseRun after;
    playPulse(p, after, flat, 20, 99);
    CHECK(after.last() == 0);
    // within 12 s: the 8-second window has to empty first, then 4 s without confirmation
    CHECK(after.bpm.size() >= 12 && after.bpm[11] == 0);
  }
  {
    // Skin contact lost: gone after half a second, and the next measurement starts from zero
    PulseEstimator p;
    PulseRun run;
    playPulse(p, run, good, 30);
    CHECK(p.bpm() != 0);
    for (int i = 0; i < 20; i++) p.addSample(3000, 2500);   // a dip of 0.2 s changes nothing
    CHECK(p.bpm() != 0);
    for (int i = 0; i < 40; i++) p.addSample(3000, 2500);   // 0.6 s in total
    CHECK(p.bpm() == 0 && p.spo2() == 0);
    PulseRun again;
    playPulse(p, again, good, 9);
    CHECK(again.bpm.empty());                               // nothing before the window is full again
    playPulse(p, again, good, 10, 5);
    CHECK(p.bpm() >= 79 && p.bpm() <= 81);
  }
}

static void testPulseRateChange() {
  section("pulse: a real change of rate is followed");
  PulseEstimator p;
  PulseRun run;
  PulseSignal s;
  s.bpm = 70;
  playPulse(p, run, s, 30);
  s.bpm = 130;
  playPulse(p, run, s, 30, 11);
  CHECK(run.last() >= 129 && run.last() <= 131);
  bool onlyOldOrNew = true;
  for (int v : run.bpm) {
    const bool oldRate = v >= 62 && v <= 72;   // the window holds both rates for a few seconds
    const bool newRate = v >= 128 && v <= 132;
    if (v != 0 && !oldRate && !newRate) onlyOldOrNew = false;
  }
  CHECK(onlyOldOrNew);
  // the new rate is reported within 12 s of the change (estimate 20 is at second 30)
  CHECK(run.bpm.size() > 32 && run.bpm[32] >= 128);
}

static void testPulseSpo2() {
  section("pulse: SpO2 follows the red to infrared ratio");
  struct Case { double ratio; int lo; int hi; };
  const Case cases[] = {{0.4, 99, 100}, {0.5, 97, 98}, {0.8, 89, 91}, {1.0, 84, 86}};
  for (const Case& c : cases) {
    PulseSignal s;
    s.bpm = 75;
    s.ratio = c.ratio;
    const PulseRun run = runPulse(s, 40);
    CHECK(run.spo2Shown() >= 25);
    CHECK(run.spo2Within(c.lo, c.hi));
  }
  // No SpO2 without a confirmed heart rate
  PulseSignal noPulse;
  noPulse.bpm = 75;
  noPulse.amplitude = 0;
  CHECK(runPulse(noPulse, 40).spo2Shown() == 0);
}

// Bench recordings of 14 Nov 2026 (firmware/tests/data): the estimator must reproduce
// on this PC what was measured on the tester.
static bool loadRecording(const char* name, std::vector<uint32_t>& ir, std::vector<uint32_t>& red) {
  std::ifstream in(std::string("data/ppg_") + name + ".csv");
  if (!in) return false;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty() || line[0] == '#') continue;
    const size_t comma = line.find(',');
    if (comma == std::string::npos) continue;
    ir.push_back((uint32_t)std::strtoul(line.c_str(), nullptr, 10));
    red.push_back((uint32_t)std::strtoul(line.c_str() + comma + 1, nullptr, 10));
  }
  return !ir.empty();
}

static PulseRun replayRecording(const char* name, bool& loaded) {
  std::vector<uint32_t> ir, red;
  loaded = loadRecording(name, ir, red);
  PulseEstimator p;
  PulseRun run;
  for (size_t i = 0; i < ir.size(); i++) feedPulse(p, ir[i], red[i], run);
  std::printf("    %-13s %3d estimates, %3d with a rate", name, (int)run.bpm.size(), run.shown());
  int lo = 999, hi = 0;
  for (int v : run.bpm) {
    if (v != 0 && v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (run.shown() > 0) std::printf(" (%d to %d BPM)", lo, hi);
  std::printf("\n");
  return run;
}

static void testPulseRecordings() {
  section("pulse: recordings of the bench measurements");
  bool loaded = false;
  {
    // Fingertip, counted pulse 92: the library detector found 6 of about 92 beats here
    const PulseRun run = replayRecording("finger", loaded);
    CHECK(loaded);
    CHECK(run.shown() * 100 >= (int)run.bpm.size() * 85);
    CHECK(run.allWithin(82, 102));
    CHECK(run.firstShownSample > 0 && run.firstShownSample <= 1500);
    CHECK(run.spo2Shown() > 0 && run.spo2Within(96, 100));
  }
  {
    // Inner side of the wrist, counted pulse 92
    const PulseRun run = replayRecording("wrist_inside", loaded);
    CHECK(loaded);
    CHECK(run.shown() * 100 >= (int)run.bpm.size() * 60);
    CHECK(run.allWithin(82, 102));
  }
  {
    // Outer side of the wrist, counted pulse 93 (during seconds 20 to 80): the pulse is
    // visible only for a short time. Few values, and none of them far off.
    const PulseRun run = replayRecording("wrist_rest", loaded);
    CHECK(loaded);
    CHECK(run.allWithin(78, 103));
    CHECK(run.shown() * 100 <= (int)run.bpm.size() * 30);
  }
  {
    // Typing: the firmware of that day reported 53 to 175 BPM here. Now: no reading.
    const PulseRun run = replayRecording("wrist_typing", loaded);
    CHECK(loaded);
    CHECK(run.shown() == 0);
  }
}

int main() {
  std::printf("SHIRO firmware logic tests\n");
  testSelfTest();
  testCanonicalFall();
  testFreefallDuration();
  testFreefallThreshold();
  testImpactThreshold();
  testImpactWindow();
  testStillness();
  testImpactSettling();
  testHoldAndCounter();
  testHoldEndsWithoutSamples();
  testClockWrap();
  testBadSamples();
  testEverydayActivities();
  testPacketLayout();
  testPacketRoundTrip();
  testPacketFallFlag();
  testPacketLimits();
  testPacketRejection();
  testVitalsFilter();
  testPulseRange();
  testPulseWeakSignal();
  testPulseNoReading();
  testPulseWithdrawal();
  testPulseRateChange();
  testPulseSpo2();
  testPulseRecordings();
  testPacketHeaderCopies();

  std::printf("\n%d checks, %d failed\n", g_checks, g_failures);
  std::printf(g_failures == 0 ? "RESULT: PASS\n" : "RESULT: FAIL\n");
  return g_failures == 0 ? 0 : 1;
}
