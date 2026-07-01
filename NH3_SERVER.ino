/**
 * ================================================================
 * NH3 Gas Detection System — PUSH NODE (SUPER DUMB SENSOR)
 * ESP32 hanya membaca Voltase mentah & Suhu, lalu Push ke Server.
 * Telah dilengkapi perbaikan Anti-Drift Timer & HTTP Anti-Blocking.
 * ================================================================
 */

#include <Arduino.h>
#include <WiFiManager.h>
#include <ArduinoOTA.h>
#include <Wire.h>
#include <SPI.h>
#include <Adafruit_SHT31.h>
#include <ADS1220_WE.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>

// ================================================================
// UBAH DOMAIN ANDA DI SINI
// ================================================================
const String SERVER_URL = "https://nh3.ijuloss.my.id/api/upload";

#define SDA_PIN          21
#define SCL_PIN          22
#define ADS_CS_PIN        5
#define ADS_DRDY_PIN      4
#define HEATER_MQ137     25
#define HEATER_TGS       26
#define LED_WIFI          2

static const uint32_t T_SENSOR_READ  = 1000; 
static const uint32_t T_ADS_TIMEOUT  = 300;
static const uint32_t T_ADS_SETTLE   = 5;
static const uint8_t  AVG_N          = 8; // Rata-rata 8 sampel untuk meredam noise

struct RawData {
  float v_mq = 0, v_tgs = 0, v_mn3 = 0, v_mrd = 0;
  float temp = 0, hum = 0;
  bool  sht_ok = false;
};

ADS1220_WE      ads(ADS_CS_PIN, ADS_DRDY_PIN);
Adafruit_SHT31  sht31;
RawData         sd;

bool     heaterMQ_on   = false;
bool     heaterTGS_on  = false;
bool     wifiConnected = false;
bool     ads_ok        = false;
bool     sht_init_ok   = false;
uint32_t tSensorRead   = 0;

// ════════════════════════════════════════════════════════════════
// FUNGSI INIT & HARDWARE
// ════════════════════════════════════════════════════════════════
bool initSHT() {
  if (sht31.begin(0x44)) return true;
  if (sht31.begin(0x45)) return true;
  return false;
}

bool initADS() {
  if (!ads.init()) return false;
  ads.setVRefSource(ADS1220_VREF_REFP0_REFN0);
  ads.setVRefValue_V(5.0); 
  ads.setGain(ADS1220_GAIN_1);
  ads.setDataRate(ADS1220_DR_LVL_3);
  ads.setOperatingMode(ADS1220_NORMAL_MODE);
  ads.setConversionMode(ADS1220_CONTINUOUS);
  return true;
}

float readADSch(ads1220Mux ch) {
  ads.setCompareChannels(ch);
  delay(T_ADS_SETTLE);
  uint32_t t0 = millis();
  while (digitalRead(ADS_DRDY_PIN) == HIGH) {
    if (millis() - t0 > T_ADS_TIMEOUT) return -999.0f;
    delayMicroseconds(200);
  }
  return ads.getVoltage_mV() / 1000.0f;
}

bool readRawSensors(RawData &out) {
  float v0 = readADSch(ADS1220_MUX_0_AVSS); // MQ-137
  float v1 = readADSch(ADS1220_MUX_1_AVSS); // MICS-NH3
  float v2 = readADSch(ADS1220_MUX_2_AVSS); // MICS-RED
  float v3 = readADSch(ADS1220_MUX_3_AVSS); // TGS2602

  if (v0 == -999.0f || v1 == -999.0f || v2 == -999.0f || v3 == -999.0f) return false;

  out.v_mq = v0; out.v_mn3 = v1; out.v_mrd = v2; out.v_tgs = v3;

  if (sht_init_ok) {
    float t = sht31.readTemperature();
    float h = sht31.readHumidity();
    out.sht_ok = !isnan(t) && !isnan(h);
    out.temp   = out.sht_ok ? t : 0.0f;
    out.hum    = out.sht_ok ? h : 0.0f;
  } else {
    out.sht_ok = false; out.temp = 0.0f; out.hum = 0.0f;
  }
  return true;
}

bool averagedRead(RawData &out, uint8_t n) {
  double av0=0, av1=0, av2=0, av3=0, aT=0, aH=0;
  uint8_t valid = 0, shtValid = 0;

  for (uint8_t i = 0; i < n; i++) {
    RawData tmp;
    if (!readRawSensors(tmp)) continue;
    av0 += tmp.v_mq; av1 += tmp.v_mn3; av2 += tmp.v_mrd; av3 += tmp.v_tgs;
    if (tmp.sht_ok) { aT += tmp.temp; aH += tmp.hum; shtValid++; }
    valid++;
  }
  
  if (valid == 0) return false;

  out.v_mq  = av0 / valid; out.v_tgs = av3 / valid; 
  out.v_mn3 = av1 / valid; out.v_mrd = av2 / valid;
  out.sht_ok = shtValid > 0;
  out.temp   = shtValid > 0 ? aT / shtValid : 0.0f;
  out.hum    = shtValid > 0 ? aH / shtValid : 0.0f;
  return true;
}

// ════════════════════════════════════════════════════════════════
// FUNGSI KOMUNIKASI & PUSH KE SERVER
// ════════════════════════════════════════════════════════════════
String buildJson() {
  char buf[400];
  // Mengirim data MENTAH (Voltase) ke server
  snprintf(buf, sizeof(buf),
    "{"
    "\"heater_mq\":%s,\"heater_tgs\":%s,"
    "\"v_mq\":%.5f,\"v_tgs\":%.5f,\"v_mn3\":%.5f,\"v_mrd\":%.5f,"
    "\"temp\":%.2f,\"hum\":%.2f,\"sht_ok\":%s,"
    "\"wifi_ok\":%s,\"wifi\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,"
    "\"uptime\":%lu,\"heap\":%u,"
    "\"ads_ok\":%s,\"sht_init\":%s"
    "}",
    heaterMQ_on ? "true":"false", heaterTGS_on ? "true":"false",
    sd.v_mq, sd.v_tgs, sd.v_mn3, sd.v_mrd,
    sd.temp, sd.hum, sd.sht_ok ? "true":"false",
    wifiConnected? "true":"false", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI(),
    millis()/1000, ESP.getFreeHeap(),
    ads_ok ? "true":"false", sht_init_ok ? "true":"false"
  );
  return String(buf);
}

void processCommand(String payload) {
  JsonDocument doc;
  if (!deserializeJson(doc, payload)) {
    String cmd = doc["cmd"].as<String>();
    
    if (cmd == "h")  { heaterMQ_on = heaterTGS_on = true; digitalWrite(HEATER_MQ137, HIGH); digitalWrite(HEATER_TGS, HIGH); }
    else if (cmd == "H")  { heaterMQ_on = heaterTGS_on = false; digitalWrite(HEATER_MQ137, LOW); digitalWrite(HEATER_TGS, LOW); }
    else if (cmd == "h1") { heaterMQ_on = !heaterMQ_on; digitalWrite(HEATER_MQ137, heaterMQ_on ? HIGH : LOW); }
    else if (cmd == "h2") { heaterTGS_on = !heaterTGS_on; digitalWrite(HEATER_TGS, heaterTGS_on ? HIGH : LOW); }
    else if (cmd == "reboot") { ESP.restart(); }
    else if (cmd == "wifi_reset") { 
      WiFiManager wm; 
      wm.resetSettings(); 
      delay(1000);
      ESP.restart(); 
    }
  }
}

void loopSensorAndSend() {
  // Cek apakah sudah waktunya mengeksekusi
  if (millis() - tSensorRead < T_SENSOR_READ) return;
  
  // ==============================================================
  // 1. KUNCI ANTI-DRIFT: Kompensasi Waktu
  // Ditambah persis 1000ms untuk menutup jeda waktu eksekusi (Drift)
  // ==============================================================
  tSensorRead += T_SENSOR_READ; 
  
  averagedRead(sd, AVG_N);

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    WiFiClientSecure secureClient;
    secureClient.setInsecure(); // Abaikan sertifikat SSL untuk menembus HTTPS

    // ==============================================================
    // 2. KUNCI ANTI-BLOCKING: Timeout 1.5 Detik
    // Mencegah ESP32 hang/berhenti jika server atau WiFi sedang lambat
    // ==============================================================
    http.setTimeout(1500); 

    if (SERVER_URL.startsWith("https://")) {
      http.begin(secureClient, SERVER_URL);
    } else {
      http.begin(SERVER_URL);
    }

    http.addHeader("Content-Type", "application/json");
    int httpCode = http.POST(buildJson());
    
    if (httpCode == HTTP_CODE_OK) {
      String response = http.getString();
      processCommand(response);
    } else {
       Serial.printf("POST Gagal/Timeout. Kode HTTP: %d\n", httpCode);
    }
    http.end();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(HEATER_MQ137, OUTPUT); digitalWrite(HEATER_MQ137, LOW);
  pinMode(HEATER_TGS,   OUTPUT); digitalWrite(HEATER_TGS,   LOW);
  pinMode(LED_WIFI,     OUTPUT); digitalWrite(LED_WIFI,     LOW);
  pinMode(ADS_DRDY_PIN, INPUT);

  Wire.begin(SDA_PIN, SCL_PIN);
  sht_init_ok = initSHT();
  SPI.begin();
  ads_ok = initADS();

  WiFiManager wm;
  if (wm.autoConnect("NH3-Node")) wifiConnected = true;
  ArduinoOTA.begin();
  
  if (wifiConnected) digitalWrite(LED_WIFI, HIGH);

  // Inisialisasi tSensorRead agar putaran pertama langsung akurat
  tSensorRead = millis();
}

void loop() {
  ArduinoOTA.handle();
  loopSensorAndSend();
}