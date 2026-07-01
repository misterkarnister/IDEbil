import { execSync } from 'child_process';
import os from 'os';


try {
    // 1. Instalacja zależności Node.js (express, ws, node-pty itp.)
    console.log("📦 Installing npm packages (this might take a while)");
    execSync('npm install', { stdio: 'inherit' });
    console.log("✅ Finished");

   

    console.log("\n🎉 Installation process complete; Start IDE with: npm start");

} catch (error) {
    console.error("❌ Something went wrong:", error.message);
}
