# Usamos una imagen de Node.js optimizada y ligera
FROM node:18-slim

# Instalamos las dependencias del sistema necesarias para Puppeteer / Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    libx11-6 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libnss3 \
    libcups2 \
    libxss1 \
    libxrandr2 \
    libatk1.0-0 \
    libgtk-3-0 \
    libasound2 \
    libgbm-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Directorio de trabajo en el contenedor
WORKDIR /app

# Copiamos primero el package.json y package-lock.json (si existe) para cachear las dependencias
COPY package*.json ./

# Instalamos las dependencias (incluyendo puppeteer)
RUN npm install

# Copiamos el resto del codigo de la API
COPY . .

# Exponemos el puerto que usa el servidor
EXPOSE 3001

# Koyeb inyecta su propio puerto en la variable de entorno PORT, 
# la API de anime1v deberia usar process.env.PORT si esta disponible.
ENV PORT=3001
ENV DISABLE_AUTH=true

# Comando para iniciar el servidor
CMD ["npm", "start"]
