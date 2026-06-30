import { execSync } from 'child_process';
import os from 'os';

console.log("🛠️ Rozpoczynamy instalację środowiska dla I DEbil...");

const platform = os.platform();

try {
    // 1. Instalacja zależności Node.js (express, ws, node-pty itp.)
    console.log("📦 1/2 Instalowanie paczek z npm (to może chwilę potrwać)...");
    execSync('npm install', { stdio: 'inherit' });
    console.log("✅ Paczki npm zainstalowane pomyślnie.");

    // 2. Sprawdzanie i instalacja narzędzi C++ (GCC/GDB)
    console.log("\n🔍 2/2 Sprawdzanie dostępności kompilatora C++ i debuggera GDB...");
    
    if (platform === 'linux') {
        console.log("🐧 Wykryto system Linux. Instaluję build-essential oraz gdb...");
        // Debian/Ubuntu
        try {
            execSync('sudo apt-get update && sudo apt-get install -y build-essential gdb', { stdio: 'inherit' });
        } catch {
            // Fedora/RHEL
            execSync('sudo dnf groupinstall -y "Development Tools" && sudo dnf install -y gdb', { stdio: 'inherit' });
        }
        console.log("✅ Narzędzia C++ zostały zainstalowane!");

    } else if (platform === 'darwin') {
        console.log("🍎 Wykryto system macOS. Instaluję Xcode Command Line Tools...");
        try {
            execSync('xcode-select --install', { stdio: 'inherit' });
        } catch (e) {
            console.log("ℹ️ Narzędzia Xcode są już prawdopodobnie zainstalowane lub w trakcie instalacji.");
        }
        // GDB na macu bywa problematyczne ze względu na certyfikaty, często używa się lldb, 
        // ale instalacja przez Homebrew jest możliwa:
        console.log("ℹ️ Jeśli potrzebujesz GDB, zalecane jest wykonanie: brew install gdb");

    } else if (platform === 'win32') {
        console.log("🪟 Wykryto system Windows.");
        console.log("⚠️ Windows wymaga środowiska MinGW-w64 (GCC/GDB), którego nie da się łatwo zainstalować jednym skryptem tła bez uprawnień administratora.");
        console.log("\n💡 ABY ZAKOŃCZYĆ INSTALACJĘ NA WINDOWS:");
        console.log("1. Pobierz i zainstaluj MSYS2 z oficjalnej strony: https://www.msys2.org/");
        console.log("2. W terminalu MSYS2 wpisz komendę uaktualniającą i instalującą toolchain:");
        console.log("   pacman -S sync --needed mingw-w64-x86_64-toolchain");
        console.log("3. Dodaj ścieżkę `C:\\msys64\\mingw64\\bin` do zmiennych środowiskowych PATH systemu Windows.");
    }

    console.log("\n🎉 Proces instalacji zakończony! Możesz teraz uruchomić IDE za pomocą: npm start");

} catch (error) {
    console.error("❌ Wystąpił błąd podczas instalacji:", error.message);
}
