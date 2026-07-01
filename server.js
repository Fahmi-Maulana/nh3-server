const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public')); 

const CSV_PATH = path.join(__dirname, 'dataset.csv');
const CALIB_PATH = path.join(__dirname, 'calibration.json');

// [PERBAIKAN 1]: Header CSV menggunakan Title Case / Huruf Kapital yang rapi dan benar
const CSV_HEADER = "No,Timestamp_ms,Humidity,Temperature,Rs_MQ137_kOhm,Rs_TGS2602_kOhm,Rs_MiCS_NH3_kOhm,Rs_MiCS_Red_kOhm,Ratio_MQ137,Ratio_TGS2602,Ratio_MiCS_NH3,Ratio_MiCS_Red,PPM_Calc_MQ,PPM_Calc_TGS,PPM_Calc_MN3,PPM_Calc_MRD,PPM_Actual,Class_Label,Class_Name\n";

let calibData = { done: false, r0_mq: 0, r0_tgs: 0, r0_mn3: 0, r0_mrd: 0 };
if (fs.existsSync(CALIB_PATH)) {
    try { calibData = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf-8')); } catch (e) {}
}

let serverState = { stream: false, label: "AMAN", class_label: 0, ppm: 0.0, rows_sess: 0, total_rows: 0 };

// [PERBAIKAN STATE RECOVERY]: Membaca baris dataset lama saat Docker restart agar total_rows melanjutkan data sebelumnya
if (fs.existsSync(CSV_PATH)) {
    try {
        const fileContent = fs.readFileSync(CSV_PATH, 'utf-8').trim();
        if (fileContent) {
            const lines = fileContent.split('\n');
            if (lines.length > 1) {
                serverState.total_rows = lines.length - 1; // Mengurangi baris header
            }
        }
    } catch (e) {}
}

let calState = { running: false, count: 0, acc_mq: 0, acc_tgs: 0, acc_mn3: 0, acc_mrd: 0 };
let latestData = {};
let pendingCmd = "";
let pendingVal = "";

let lastEspUpdate = 0; 
let heaterStartTime = 0; 

const V_GAS_SUPPLY = 5.0;
const RL_MQ = 47.0;
const RL_TGS = 10.0;
const RL_MN3 = 47.0;
const RL_MRD = 47.0;

function calculatePPM(ratio, A, B, maxPPM) {
    if (ratio <= 0) return -1.0;
    let ppm = A * Math.pow(ratio, B);
    return (ppm > maxPPM) ? maxPPM : ppm; 
}

app.post('/api/upload', (req, res) => {
    let d = req.body;
    lastEspUpdate = Date.now();

    if (d.heater_mq === true && d.heater_tgs === true) {
        if (heaterStartTime === 0) heaterStartTime = Date.now();
        let elapsedSec = Math.floor((Date.now() - heaterStartTime) / 1000);
        d.warmup_left = 300 - elapsedSec; 
        if (d.warmup_left <= 0) { d.warmup_left = 0; d.warmup_ready = true; } 
        else { d.warmup_ready = false; }
    } else {
        heaterStartTime = 0; 
        d.warmup_left = 300;
        d.warmup_ready = false;
    }

    d.rs_mq = (d.v_mq > 0.001 && d.v_mq < V_GAS_SUPPLY) ? RL_MQ * (V_GAS_SUPPLY - d.v_mq) / d.v_mq : 0;
    d.rs_tgs = (d.v_tgs > 0.001 && d.v_tgs < V_GAS_SUPPLY) ? RL_TGS * (V_GAS_SUPPLY - d.v_tgs) / d.v_tgs : 0;
    d.rs_mn3 = (d.v_mn3 > 0.001 && d.v_mn3 < V_GAS_SUPPLY) ? RL_MN3 * d.v_mn3 / (V_GAS_SUPPLY - d.v_mn3) : 0;
    d.rs_mrd = (d.v_mrd > 0.001 && d.v_mrd < V_GAS_SUPPLY) ? RL_MRD * d.v_mrd / (V_GAS_SUPPLY - d.v_mrd) : 0;

    // [PERBAIKAN 2]: Proteksi Data Nol saat Kalibrasi Berjalan
    if (calState.running) {
        if (d.rs_mq > 0 && d.rs_tgs > 0 && d.rs_mn3 > 0 && d.rs_mrd > 0) {
            calState.acc_mq += d.rs_mq;
            calState.acc_tgs += d.rs_tgs;
            calState.acc_mn3 += d.rs_mn3;
            calState.acc_mrd += d.rs_mrd;
            calState.count++;

            if (calState.count >= 30) {
                calibData.r0_mq = calState.acc_mq / 30;
                calibData.r0_tgs = calState.acc_tgs / 30;
                calibData.r0_mn3 = calState.acc_mn3 / 30;
                calibData.r0_mrd = calState.acc_mrd / 30;
                calibData.done = true;
                fs.writeFileSync(CALIB_PATH, JSON.stringify(calibData));
                calState.running = false;
            }
        }
    }

    d.ratio_mq = (calibData.done && calibData.r0_mq > 0) ? d.rs_mq / calibData.r0_mq : -1.0;
    d.ratio_tgs = (calibData.done && calibData.r0_tgs > 0) ? d.rs_tgs / calibData.r0_tgs : -1.0;
    d.ratio_mn3 = (calibData.done && calibData.r0_mn3 > 0) ? d.rs_mn3 / calibData.r0_mn3 : -1.0;
    d.ratio_mrd = (calibData.done && calibData.r0_mrd > 0) ? d.rs_mrd / calibData.r0_mrd : -1.0;

    d.ppm_mq = (d.ratio_mq >= 1.1) ? 0.0 : calculatePPM(d.ratio_mq, 0.402, -2.51, 500.0);
    d.ppm_tgs = (d.ratio_tgs >= 1.1) ? 0.0 : calculatePPM(d.ratio_tgs, 0.592, -2.35, 30.0);
    d.ppm_mn3 = (d.ratio_mn3 >= 1.1) ? 0.0 : calculatePPM(d.ratio_mn3, 0.637, -2.03, 300.0);
    d.ppm_mrd = (d.ratio_mrd >= 1.1) ? 0.0 : calculatePPM(d.ratio_mrd, 0.777, -2.39, 1000.0);

    let stats = fs.existsSync(CSV_PATH) ? fs.statSync(CSV_PATH) : { size: 0 };
    d.file_kb = stats.size / 1024.0;
    d.file_rows = serverState.total_rows;
    d.rows_sess = serverState.rows_sess;
    d.stream = serverState.stream;
    d.label = serverState.label;
    d.class_label = serverState.class_label;
    d.ppm = serverState.ppm; 
    d.calib = calibData.done;
    d.cal_run = calState.running;
    d.cal_cnt = calState.count;
    d.r0_mq = calibData.r0_mq;
    d.r0_tgs = calibData.r0_tgs;
    d.r0_mn3 = calibData.r0_mn3;
    d.r0_mrd = calibData.r0_mrd;

    latestData = d; 

    if (serverState.stream) {
        if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) {
            fs.writeFileSync(CSV_PATH, CSV_HEADER);
            serverState.total_rows = 0; 
        }
        serverState.total_rows++;
        serverState.rows_sess++;
        
        const row = `${serverState.total_rows},${Date.now()},${d.hum.toFixed(2)},${d.temp.toFixed(2)},${d.rs_mq.toFixed(4)},${d.rs_tgs.toFixed(4)},${d.rs_mn3.toFixed(4)},${d.rs_mrd.toFixed(4)},${d.ratio_mq.toFixed(6)},${d.ratio_tgs.toFixed(6)},${d.ratio_mn3.toFixed(6)},${d.ratio_mrd.toFixed(6)},${d.ppm_mq.toFixed(2)},${d.ppm_tgs.toFixed(2)},${d.ppm_mn3.toFixed(2)},${d.ppm_mrd.toFixed(2)},${serverState.ppm},${serverState.class_label},${serverState.label}\n`;
        
        fs.appendFileSync(CSV_PATH, row);
    }

    res.json({ cmd: pendingCmd, val: pendingVal });
    pendingCmd = "";
    pendingVal = "";
});

app.get('/api/data', (req, res) => {
    latestData.esp_connected = (Date.now() - lastEspUpdate) < 4000;
    res.json(latestData);
});

app.get('/api/cmd', (req, res) => {
    const cmd = req.query.cmd;
    const val = req.query.val || "";
    let msg = "OK";

    if (cmd === 's') {
        serverState.stream = true;
        if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) {
            fs.writeFileSync(CSV_PATH, CSV_HEADER);
            serverState.total_rows = 0;
        }
        msg = "Stream Dimulai dari Server.";
    } 
    else if (cmd === 'x') { serverState.stream = false; msg = "Stream Berhenti."; }
    else if (cmd === 'label') { serverState.label = val; }
    else if (cmd === 'cl') { serverState.class_label = parseInt(val); }
    else if (cmd === 'ppm') { serverState.ppm = parseFloat(val); }
    else if (cmd === 'file_clear') { 
        try {
            fs.writeFileSync(CSV_PATH, CSV_HEADER);
            serverState.total_rows = 0; serverState.rows_sess = 0;
            msg = "File Dataset Dihapus (Di-reset) di Server.";
        } catch (err) {
            msg = "Gagal me-reset file: " + err.message;
        }
    }
    else if (cmd === 'c') {
        if (latestData.warmup_ready !== true) {
            msg = "GAGAL: Heater belum menyala penuh selama 5 menit!";
        } else {
            calState.running = true;
            calState.count = 0;
            calState.acc_mq = 0; calState.acc_tgs = 0; calState.acc_mn3 = 0; calState.acc_mrd = 0;
            msg = "Memulai Kalibrasi 30 Detik dari Server...";
        }
    }
    else {
        pendingCmd = cmd;
        pendingVal = val;
        msg = "Perintah diteruskan ke ESP32...";
    }
    res.json({ msg });
});

app.get('/dataset.csv', (req, res) => {
    if (fs.existsSync(CSV_PATH)) res.download(CSV_PATH);
    else res.status(404).send("File tidak ada.");
});

app.listen(PORT, () => {
    console.log(`NH3 API Server berjalan di Port ${PORT}`);
});