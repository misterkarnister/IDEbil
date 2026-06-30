import { spawn, exec } from 'child_process';
import os from 'os';

console.log("🚀 Uruchamianie komponentów IDE (I DEbil)...");

// 1. Uruchomienie hostowania frontendu (npx serve)
// Używamy opcji -l 3000, aby wymusić port 3000, o którym pisałeś
const frontend = spawn('npx', ['serve', '.', '-l', '3000'], { 
    shell: true, 
    stdio: 'inherit' 
});

// 2. Uruchomienie backendu (node server.js)
const backend = spawn('node', ['server.js'], { 
    shell: true, 
    stdio: 'inherit' 
});

// Funkcja obsługująca bezpieczne zamykanie wszystkich procesów na raz
const cleanup = () => {
    console.log("\n🛑 Zamykanie serwerów...");
    frontend.kill();
    backend.kill();
    process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// 3. Odczekanie 2 sekund na wstępne podniesienie serwerów i otwarcie Firefoxa
setTimeout(() => {
    const platform = os.platform();
    const url = 'http://localhost:3000';
    
    console.log(`🌐 Otwieranie przeglądarki Firefox (${platform})...`);
    
    if (platform === 'win32') {
        // Windows (często wymaga pełnej ścieżki lub wywołania start, szukamy domyślnego firefox w PATH)
        exec(`start firefox ${url}`);
    } else if (platform === 'darwin') {
        // macOS
        exec(`open -a "Firefox" ${url}`);
    } else {
        // Linux
        exec(`firefox ${url}`);
    }
}, 2000);
