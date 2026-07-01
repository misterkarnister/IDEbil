import { execSync } from 'child_process';
import os from 'os';

console.log("🛠️ Rozpoczynamy instalację środowiska dla I DEbil...");

const platform = os.platform();

try {
    // 1. Instalacja zależności Node.js (express, ws, node-pty itp.)
    console.log("📦 Instalowanie paczek z npm (to może chwilę potrwać)...");
    execSync('npm install', { stdio: 'inherit' });
    console.log("✅ Paczki npm zainstalowane pomyślnie.");

   

    console.log("\n🎉 Proces instalacji zakończony! Możesz teraz uruchomić IDE za pomocą: npm start");

} catch (error) {
    console.error("❌ Wystąpił błąd podczas instalacji:", error.message);
}
