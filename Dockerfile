# Menggunakan image Node.js versi ringan
FROM node:18-alpine

# Menentukan direktori kerja di dalam container
WORKDIR /app

# Menyalin package.json dan menginstal dependensi
COPY package.json ./
RUN npm install

# Menyalin seluruh kode (server.js dan folder public)
COPY . .

# Membuat file dataset.csv kosong jika belum ada untuk mapping volume
RUN touch dataset.csv

# Mengekspos port 3000
EXPOSE 3000

# Menjalankan aplikasi
CMD ["node", "server.js"]