import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs-extra'; 
import path from 'path';
import { exec } from 'child_process';
import { createRequire } from 'module';
import { WebSocketServer } from 'ws';
const require = createRequire(import.meta.url);

const pty = require('node-pty');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());


// Root directory where all projects will be physically stored on your computer
const WORKSPACE_ROOT = path.join(process.cwd(), 'projects');

// Ensure the root project folder exists
fs.ensureDirSync(WORKSPACE_ROOT);

// --- 1. PHYSICAL FILE SYSTEM ENDPOINTS ---

// Delete a physical file or the entire project folder if .pjt is targeted
app.post('/api/file/delete', async (req, res) => {
    try {
        const { projectName, filePath } = req.body;
        if (!projectName || !filePath) {
            return res.status(400).json({ success: false, error: "Missing arguments." });
        }

        const projectPath = path.join(WORKSPACE_ROOT, projectName);
        
        // --- KLUCZOWA ZMIANA LOGIKI ---
        // Jeśli usuwany plik to konfiguracja projektu (*.pjt), celem staje się CAŁY folder projektu
        const isProjectConfig = filePath.endsWith('.pjt');
        const targetPathOnDisk = isProjectConfig ? projectPath : path.join(projectPath, filePath);

        // Security check: ensure we are not climbing out of the workspace root
        if (!targetPathOnDisk.startsWith(WORKSPACE_ROOT)) {
            return res.status(403).json({ success: false, error: "Access Denied." });
        }

        // Check if path exists, then remove it completely
        if (await fs.exists(targetPathOnDisk)) {
            await fs.remove(targetPathOnDisk); // fs.remove recursively deletes folders and files
            
            res.json({ 
                success: true, 
                projectDeleted: isProjectConfig, // informujemy frontend czy usunęliśmy cały projekt
                message: isProjectConfig ? "Entire project folder deleted." : "File deleted successfully." 
            });
        } else {
            res.status(404).json({ success: false, error: "Target path not found on disk." });
        }
    } catch (error) {
        console.error("❌ Failed to delete asset:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});// Execute terminal command inside the project directory root context
app.post('/api/terminal/run', async (req, res) => {
    try {
        const { projectName, command } = req.body;
        if (!projectName || !command) {
            return res.status(400).json({ success: false, error: "Missing arguments." });
        }

        const projectPath = path.join(WORKSPACE_ROOT, projectName);

        // Security / Safety sanity check: don't look outside the workspace folder
        if (!projectPath.startsWith(WORKSPACE_ROOT)) {
            return res.status(403).json({ success: false, error: "Access Denied." });
        }

        // Run the command explicitly inside the target directory path option
        exec(command, { cwd: projectPath }, (error, stdout, stderr) => {
            // Package outputs together cleanly
            res.json({
                success: true,
                stdout: stdout || "",
                stderr: stderr || "",
                exitCode: error ? error.code : 0
            });
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Open an existing project and scan its directories
app.post('/api/project/open', async (req, res) => {
    try {
        const { projectName } = req.body;
        if (!projectName) return res.status(400).json({ error: "Missing project name" });

        const projectPath = path.join(WORKSPACE_ROOT, projectName);
        
        if (!(await fs.pathExists(projectPath))) {
            return res.status(404).json({ success: false, error: "Project folder not found." });
        }

        const workspaceFiles = {};

        // 1. Scan for the .pjt configuration file
        const rootFiles = await fs.readdir(projectPath);
        const pjtFile = rootFiles.find(f => f.endsWith('.pjt'));
        if (pjtFile) {
            const pjtContent = await fs.readJson(path.join(projectPath, pjtFile));
            workspaceFiles[pjtFile] = JSON.stringify(pjtContent, null, 4);
        }

        // 2. Helper function to scan subdirectories dynamically
        const scanSubDir = async (subDir) => {
            const targetPath = path.join(projectPath, subDir);
            if (await fs.pathExists(targetPath)) {
                const files = await fs.readdir(targetPath);
                for (const file of files) {
                    const content = await fs.readFile(path.join(targetPath, file), 'utf-8');
                    // Store using its clean explicit path (e.g., 'src/main.cpp')
                    workspaceFiles[`${subDir}/${file}`] = content;
                }
            }
        };

        await scanSubDir('src');
        await scanSubDir('include');

        res.json({ success: true, files: workspaceFiles });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create a brand new project directory structure
app.post('/api/project/create', async (req, res) => {
    try {
        const { projectName } = req.body;
        if (!projectName) return res.status(400).json({ error: "Missing project name" });

        const projectPath = path.join(WORKSPACE_ROOT, projectName);
        
        // Physically create subfolders on your computer
        await fs.ensureDir(projectPath);
        await fs.ensureDir(path.join(projectPath, 'src'));
        await fs.ensureDir(path.join(projectPath, 'include'));
        await fs.ensureDir(path.join(projectPath, 'lib'));

        // Define and write the configuration .pjt file
        const pjtData = {
            project_name: projectName,
            source_dir: "./src",
            include_dir: "./include",
            link_libraries: ["./lib/libm.a"]
        };
        await fs.writeJson(path.join(projectPath, `${projectName}.pjt`), pjtData, { spaces: 4 });

        // Add a default main.cpp boilerplate physically inside /src
        const boilerplate = `#include <iostream>\n\nint main() {\n    std::cout << "Physical C++ Workspace Loaded!" << std::endl;\n    return 0;\n}\n`;
        await fs.writeFile(path.join(projectPath, 'src', 'main.cpp'), boilerplate);

        res.json({ success: true, message: "Project created physically!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Save modifications to a file physically
app.post('/api/file/save', async (req, res) => {
    try {
        const { projectName, filePath, content } = req.body;
        const absolutePath = path.join(WORKSPACE_ROOT, projectName, filePath);
        
        await fs.writeFile(absolutePath, content);
        res.json({ success: true, message: "File saved to disk!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// --- 2. STRUCTURAL OPENROUTER CO-PILOT ENDPOINT ---
app.post('/api/analyze', async (req, res) => {
    try {
        const { code, prompt, projectName, activeFile } = req.body;
        
        if (!projectName) {
            return res.status(400).json({ success: false, error: "No active project folder detected." });
        }

        const projectRootPath = path.join(WORKSPACE_ROOT, projectName);
        let aggregatedContext = "";
        let cleanPrompt = prompt;

        // --- CASE 1: USER REQUESTS THE ENTIRE PROJECT OVERVIEW WITH @all ---
        if (prompt && prompt.includes('@all')) {
            cleanPrompt = prompt.replace('@all', '').trim();
            const targetDirs = ['src', 'include'];
            
            for (const subDir of targetDirs) {
                const fullDir = path.join(projectRootPath, subDir);
                if (await fs.pathExists(fullDir)) {
                    const dirFiles = await fs.readdir(fullDir);
                    for (const file of dirFiles) {
                        const fileContent = await fs.readFile(path.join(fullDir, file), 'utf-8');
                        aggregatedContext += `\n--- File: ${subDir}/${file} ---\n\`\`\`cpp\n${fileContent}\n\`\`\`\n`;
                    }
                }
            }
        } 
        // --- CASE 2: USER TARGETS SPECIFIC FILES WITH @path ---
        else if (prompt && prompt.includes('@')) {
            const matches = prompt.match(/@([^\s]+)/g);
            if (matches) {
                for (const match of matches) {
                    cleanPrompt = cleanPrompt.replace(match, '').trim();
                    const relativePath = match.replace('@', '');
                    const absoluteTargetFile = path.join(projectRootPath, relativePath);

                    if (await fs.pathExists(absoluteTargetFile)) {
                        const fileContent = await fs.readFile(absoluteTargetFile, 'utf-8');
                        aggregatedContext += `\n--- File: ${relativePath} ---\n\`\`\`cpp\n${fileContent}\n\`\`\`\n`;
                    } else {
                        aggregatedContext += `\n--- [Warning: Specified file "${relativePath}" not found on disk] ---\n`;
                    }
                }
            }
        } 
        // --- CASE 3: FALLBACK TO ONLY THE ACTIVE OPEN TAB ---
        else {
            aggregatedContext = `\n--- Current Active File: ${activeFile || 'None'} ---\n\`\`\`cpp\n${code || ''}\n\`\`\`\n`;
        }

        // 1. Dispatch request to OpenRouter using Llama 3 8b (Guaranteed stable on free tier JSON formats)
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "model": "qwen/qwen-2.5-coder-32b-instruct",
                "messages": [
                    {
                        "role": "user",
                        "content": `You are an automated code refactoring engine. Analyze the code context and fulfill the user instruction.

You must output your answer strictly inside raw text as a valid JSON object matching this schema blueprint structure:
{
    "explanation": "Summary of modifications.",
    "modifications": [
        {
            "action": "edit",
            "targetPath": "src/oki.cpp",
            "code": "paste code here"
        }
    ]
}

PROJECT FILES CONTEXT PROVIDED:
${aggregatedContext}

USER INSTRUCTION:
${cleanPrompt || "Review the attached files for bugs."}
`
                    }
                ]
            })
        });

        // --- BULLETPROOF RAW RESPONSE GRABBER ---
        const responseText = await response.text();
        let openRouterData;
        
        try {
            openRouterData = JSON.parse(responseText);
        } catch (e) {
            console.error("❌ Failed to parse OpenRouter core response JSON. Raw text payload was:\n", responseText);
            return res.json({
                success: true,
                data: {
                    explanation: "OpenRouter returned an unreadable network transmission frame. Let's send that request down one more time.",
                    modifications: []
                }
            });
        }
        
        if (!response.ok || openRouterData.error) {
            console.error("❌ OpenRouter API Error Payload:", JSON.stringify(openRouterData, null, 2));
            return res.json({
                success: true,
                data: {
                    explanation: `API Connection Error: ${openRouterData.error?.message || 'Status Code ' + response.status}. Check your backend terminal window for details.`,
                    modifications: []
                }
            });
        }

        let rawText = openRouterData.choices?.[0]?.message?.content || "";
        
        // --- Bulletproof JSON Extraction Layer ---
        if (rawText.includes("```json")) {
            rawText = rawText.split("```json")[1].split("```")[0].trim();
        } else if (rawText.includes("```")) {
            rawText = rawText.split("```")[1].split("```")[0].trim();
        }

        const firstBracket = rawText.indexOf('{');
        const lastBracket = rawText.lastIndexOf('}');
        if (firstBracket !== -1 && lastBracket !== -1) {
            rawText = rawText.substring(firstBracket, lastBracket + 1);
        }

        try {
            const parsedData = JSON.parse(rawText);
            res.json({ success: true, data: parsedData });
        } catch (parseError) {
            console.error("❌ JSON structural parsing failed. Raw text was:\n", rawText);
            res.json({ 
                success: true, 
                data: {
                    explanation: "The model's output formatting contained structural anomalies. Let's try submitting that adjustment prompt one more time.",
                    modifications: []
                } 
            });
        }

    } catch (error) {
        console.error("❌ Copilot integration step failed completely:", error);
        res.json({
            success: true,
            data: {
                explanation: `Critical runtime backend failure: ${error.message}. Check your console output log.`,
                modifications: []
            }
        });
    }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Physical Storage Backend running on http://localhost:${PORT}`));
// Upewnij się, że na dole server.js sekcja WebSocket wygląda tak:

const wss = new WebSocketServer({ port: 5001 });

console.log("🚀 Interactive Terminal WebSocket server running on port 5001");

wss.on('connection', (ws) => {
    let ptyProcess = null;

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            data = { type: 'input', data: String(message).trim() };
        }

        if (data.type === 'init') {
            const projectPath = path.join(WORKSPACE_ROOT, data.projectName);
            const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';

            ptyProcess = pty.spawn(shell, [], {
                name: 'xterm-color',
                cols: 80,
                rows: 24,
                cwd: projectPath,
                env: process.env
            });

            ptyProcess.onData((output) => {
                ws.send(JSON.stringify({ type: 'output', data: output }));
            });

            ptyProcess.onExit(({ exitCode }) => {
                ws.send(JSON.stringify({ type: 'exit', data: `\n[Process exited with code ${exitCode}]` }));
            });
        }

        if (data.type === 'input' && ptyProcess) {
            ptyProcess.write(data.data + '\r');
        }
    });

    ws.on('close', () => {
        if (ptyProcess) {
            ptyProcess.kill();
        }
    });
});
