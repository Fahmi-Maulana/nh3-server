# NH3 Sensor Web Dashboard Server

Server backend berbasis **Node.js + Express** untuk monitoring dan pengumpulan data sensor gas **Amonia (NH3)** secara real-time dari perangkat **ESP32**. Dilengkapi dengan dashboard web interaktif, kalkulasi PPM multi-sensor, kalibrasi otomatis, dan penyimpanan dataset CSV.

---

## Daftar Isi

- [Fitur Utama](#fitur-utama)
- [Arsitektur Sistem](#arsitektur-sistem)
- [Sensor yang Didukung](#sensor-yang-didukung)
- [Struktur Proyek](#struktur-proyek)
- [Prasyarat](#prasyarat)
- [Instalasi dan Menjalankan](#instalasi-dan-menjalankan)
  - [Cara 1: Langsung dengan Node.js](#cara-1-langsung-dengan-nodejs)
  - [Cara 2: Menggunakan Docker](#cara-2-menggunakan-docker-direkomendasikan)
- [API Endpoint](#api-endpoint)
- [Format Dataset CSV](#format-dataset-csv)
- [Alur Kalibrasi](#alur-kalibrasi)
- [Konfigurasi](#konfigurasi)

---

## Fitur Utama

- **Penerimaan Data Real-Time** - Menerima data sensor dari ESP32 via HTTP POST setiap detik
- **Dashboard Web Interaktif** - Antarmuka berbasis browser untuk monitoring langsung
- **Kalkulasi Rs dan Ratio** - Menghitung resistansi sensor (Rs) dan rasio Rs/R0 secara otomatis
- **Estimasi PPM Multi-Sensor** - Menghitung konsentrasi NH3 dalam PPM dari 4 sensor berbeda
- **Kalibrasi Otomatis** - Proses kalibrasi 30 detik dengan 30 sampel rata-rata
- **Penyimpanan Dataset CSV** - Logging data ke file CSV untuk keperluan training model ML
- **Pelabelan Data** - Mendukung pemberian label kelas untuk kebutuhan supervised learning
- **Docker Support** - Mudah di-deploy menggunakan Docker dan Docker Compose
- **State Recovery** - Melanjutkan penomoran baris dataset secara otomatis setelah restart

---

## Arsitektur Sistem

```
+------------------+    HTTP POST /api/upload    +------------------------+
|     ESP32        | --------------------------> |                        |
|  (IoT Device)    |                             |      NH3 Server        |
|                  | <-------------------------- |   (Node.js/Express)    |
|                  |     JSON {cmd, val}         |                        |
+------------------+                             +------------+-----------+
                                                              |
                                               +--------------+--------------+
                                               |              |              |
                                          dataset.csv   calibration    Dashboard
                                          (logging)       .json       (Browser)
```

---

## Sensor yang Didukung

| Sensor    | Jenis Gas   | Range PPM | Konstanta A | Konstanta B | RL (kOhm) |
|-----------|-------------|-----------|-------------|-------------|-----------|
| MQ-137    | NH3         | 0 - 500   | 0.402       | -2.51       | 47        |
| TGS2602   | NH3/VOC     | 0 - 30    | 0.592       | -2.35       | 10        |
| MiCS NH3  | NH3         | 0 - 300   | 0.637       | -2.03       | 47        |
| MiCS Red  | CO/Reducing | 0 - 1000  | 0.777       | -2.39       | 47        |

> Formula kalkulasi PPM: `PPM = A x (Rs/R0)^B`

---

## Struktur Proyek

```
nh3-server/
+-- server.js           Server utama (Express API + logika kalkulasi)
+-- package.json        Konfigurasi npm dan dependensi
+-- Dockerfile          Build image Docker
+-- docker-compose.yml  Orkestrasi container Docker
+-- calibration.json    Data hasil kalibrasi R0 (auto-generated)
+-- dataset.csv         Dataset hasil logging sensor (auto-generated)
+-- public/
    +-- index.html      Dashboard web (Single Page Application)
```

---

## Prasyarat

- Node.js v18 atau lebih baru
- npm v8+
- Docker dan Docker Compose (opsional, untuk deployment container)

---

## Instalasi dan Menjalankan

### Cara 1: Langsung dengan Node.js

```bash
# 1. Clone atau ekstrak proyek ini
cd nh3-server

# 2. Install dependensi
npm install

# 3. Jalankan server
npm start
```

Server akan berjalan di: `http://localhost:3000`

---

### Cara 2: Menggunakan Docker (Direkomendasikan)

Docker memastikan data CSV dan kalibrasi tidak hilang saat container di-restart berkat konfigurasi volume.

```bash
# 1. Build dan jalankan container
docker compose up -d --build

# 2. Cek status container
docker compose ps

# 3. Lihat log server
docker compose logs -f
```

Server akan dapat diakses di: `http://localhost:3030`

> Catatan: Port host adalah `3030`, yang di-mapping ke port `3000` di dalam container.

#### Menghentikan Server

```bash
docker compose down
```

---

## API Endpoint

### POST /api/upload

Digunakan oleh ESP32 untuk mengirim data sensor. Server akan membalas dengan perintah pending jika ada.

**Request Body (JSON):**

```json
{
  "v_mq": 2.5,
  "v_tgs": 1.8,
  "v_mn3": 0.9,
  "v_mrd": 1.2,
  "hum": 65.3,
  "temp": 27.4,
  "heater_mq": true,
  "heater_tgs": true
}
```

**Response:**

```json
{
  "cmd": "s",
  "val": ""
}
```

---

### GET /api/data

Mengembalikan data sensor terbaru yang telah diproses.

**Response:**

```json
{
  "rs_mq": 112.5,
  "rs_tgs": 28.1,
  "ratio_mq": 0.998,
  "ppm_mq": 5.2,
  "ppm_tgs": 1.8,
  "stream": true,
  "calib": true,
  "esp_connected": true,
  "warmup_ready": true,
  "warmup_left": 0
}
```

---

### GET /api/cmd

Query params: `cmd` dan `val` (opsional).

| Perintah   | Nilai (val)   | Keterangan                                         |
|------------|---------------|----------------------------------------------------|
| s          | -             | Mulai streaming / logging data ke CSV              |
| x          | -             | Stop streaming                                     |
| c          | -             | Mulai kalibrasi (heater harus warm-up 5 menit)     |
| label      | teks label    | Set label teks kelas (contoh: AMAN, BAHAYA)        |
| cl         | angka integer | Set nomor kelas (contoh: 0, 1, 2)                  |
| ppm        | angka float   | Set nilai PPM aktual / referensi                   |
| file_clear | -             | Reset / hapus isi dataset CSV                      |

**Contoh penggunaan:**

```
GET /api/cmd?cmd=s
GET /api/cmd?cmd=label&val=BAHAYA
GET /api/cmd?cmd=ppm&val=25.5
```

---

### GET /dataset.csv

Mengunduh file dataset CSV secara langsung.

---

## Format Dataset CSV

File `dataset.csv` menggunakan format berikut:

| Kolom             | Tipe   | Keterangan                                    |
|-------------------|--------|-----------------------------------------------|
| No                | int    | Nomor urut baris data                         |
| Timestamp_ms      | int    | Waktu Unix dalam milidetik                    |
| Humidity          | float  | Kelembaban udara (%)                          |
| Temperature       | float  | Suhu udara (Celsius)                          |
| Rs_MQ137_kOhm     | float  | Resistansi sensor MQ-137 (kOhm)               |
| Rs_TGS2602_kOhm   | float  | Resistansi sensor TGS2602 (kOhm)              |
| Rs_MiCS_NH3_kOhm  | float  | Resistansi sensor MiCS NH3 (kOhm)             |
| Rs_MiCS_Red_kOhm  | float  | Resistansi sensor MiCS Reducing (kOhm)        |
| Ratio_MQ137       | float  | Rasio Rs/R0 sensor MQ-137                     |
| Ratio_TGS2602     | float  | Rasio Rs/R0 sensor TGS2602                    |
| Ratio_MiCS_NH3    | float  | Rasio Rs/R0 sensor MiCS NH3                   |
| Ratio_MiCS_Red    | float  | Rasio Rs/R0 sensor MiCS Reducing              |
| PPM_Calc_MQ       | float  | Konsentrasi NH3 estimasi dari MQ-137 (ppm)    |
| PPM_Calc_TGS      | float  | Konsentrasi NH3 estimasi dari TGS2602 (ppm)   |
| PPM_Calc_MN3      | float  | Konsentrasi NH3 estimasi dari MiCS NH3 (ppm)  |
| PPM_Calc_MRD      | float  | Konsentrasi NH3 estimasi dari MiCS Red (ppm)  |
| PPM_Actual        | float  | Nilai PPM referensi aktual (diset manual)     |
| Class_Label       | int    | Nomor kelas                                   |
| Class_Name        | string | Nama kelas (contoh: AMAN, BAHAYA)             |

---

## Alur Kalibrasi

Kalibrasi digunakan untuk menentukan nilai **R0** (resistansi baseline sensor di udara bersih).

```
Langkah 1  Pastikan sensor dinyalakan (heater aktif)
Langkah 2  Tunggu warm-up selama kurang lebih 5 menit (300 detik)
Langkah 3  Kirim perintah: GET /api/cmd?cmd=c
Langkah 4  Server mengumpulkan 30 sampel Rs selama kurang lebih 30 detik
Langkah 5  R0 dihitung sebagai rata-rata 30 sampel
Langkah 6  Hasil disimpan otomatis ke calibration.json
```

> PENTING: Kalibrasi hanya akan berjalan jika `warmup_ready` bernilai `true`.
> Jika heater belum menyala cukup lama, server akan menolak perintah kalibrasi.

**Contoh isi `calibration.json` setelah kalibrasi berhasil:**

```json
{
  "done": true,
  "r0_mq": 112.72,
  "r0_tgs": 28.48,
  "r0_mn3": 867.14,
  "r0_mrd": 308.82
}
```

---

## Konfigurasi

Pengaturan utama dapat diubah langsung di `server.js`:

| Variabel     | Nilai Default | Keterangan                          |
|--------------|---------------|-------------------------------------|
| PORT         | 3000          | Port server Express                 |
| V_GAS_SUPPLY | 5.0 V         | Tegangan supply sensor              |
| RL_MQ        | 47 kOhm       | Resistor beban sensor MQ-137        |
| RL_TGS       | 10 kOhm       | Resistor beban sensor TGS2602       |
| RL_MN3       | 47 kOhm       | Resistor beban sensor MiCS NH3      |
| RL_MRD       | 47 kOhm       | Resistor beban sensor MiCS Red      |

Zona waktu Docker dapat dikonfigurasi di `docker-compose.yml`:

```yaml
environment:
  - TZ=Asia/Jakarta
```

---

## Dependensi

| Package | Versi     | Keterangan              |
|---------|-----------|-------------------------|
| express | ^4.18.2   | Web framework HTTP      |
| node    | 18-alpine | Runtime (via Docker)    |

---

## Lisensi

Proyek ini dibuat untuk keperluan **penelitian dan pengembangan sistem monitoring gas NH3**.
Silakan gunakan dan modifikasi sesuai kebutuhan.
