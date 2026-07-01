require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });

require(['vs/editor/editor.main'], function () {
    let currentDebugLineDecoration = null;
    let debugActiveFile = null; // Przechowa plik, w którym aktualnie stoi debugger	
    let terminalSocket = null;
    let currentProject = null;
    const files = {};
    let activeFile = null;
    // Tablica przechowująca nazwy zmiennych do podglądu (np. ["counter", "myVar"])
    const watchedVariables = [];
    let activeWatchIndex = null; // Przechowuje indeks zaznaczonej zmiennej w watches	
    // Zmienne pomocnicze do synchronizacji parsera odpowiedzi GDB print
    let gdbVariablesToQuery = [];
    let currentQueryingVariable = null;
    // Słownik przechowujący breakpointy: { "src/main.cpp": [ { line: 5, decorationId: "..." }, ... ] }
    const projectBreakpoints = {};

    const blankModel = monaco.editor.createModel("// Open or create a project file to begin coding\n", "plaintext");
// ZMIANA: Włączona opcja glyphMargin: true
	monaco.editor.defineTheme('zaibatsu', {
        base: 'vs', // Baza jasna (ponieważ tło w XML to 255,255,255)
        inherit: true,
        rules: [
            { token: '', foreground: 'F6F5F4', background: '0E0024' },
            { token: 'comment', foreground: 'AFAFFF' },                     // Komentarze zwykłe (152,152,217)
            { token: 'comment.doc', foreground: '8080FF', fontStyle: 'bold' }, // Komentarze dokumentacji (128,128,255)
            { token: 'keyword', foreground: 'FF5FAF', fontStyle: 'bold' },    // Słowa kluczowe (0,0,160)
	    { token: 'keyword.user', foreground: 'F1A5F2', fontStyle: 'bold' },
            { token: 'number', foreground: '87FF00' },                       // Liczby (240,0,240)
            { token: 'string', foreground: 'FFFF5F' },                       // Ciągi znaków (0,0,255)
            { token: 'string.char', foreground: 'E0A000' },                  // Znaki pojedyncze 'c' (224,160,0)
            { token: 'keyword.directive', foreground: '00AFFF' },            // Preprocesor np. #include (0,160,0)
            { token: 'operator', foreground: 'C061CB' },                     // Operatory (255,0,0)
            { token: 'delimiter', foreground: 'C061CB' },                    // Nawiasy i separatory traktowane jako operatory
	    { token: 'delimiter.bracket', foreground: 'C061CB' },  // Nawiasy kwadratowe [] i okrągłe ()
            { token: 'delimiter.curly', foreground: 'C061CB' },
            { token: 'type', foreground: 'BE00BE', fontStyle: 'bold' },      // Typy globalne i typedefy (190,0,190)
            { token: 'tag', foreground: 'E89FEA', fontStyle: 'bold' }        // Słowa kluczowe użytkownika (0,160,0)
        ],
        colors: {
            'editor.background': '#0E0024',         // Tło edytora (Białe)
            'editor.foreground': '#F6F5F4',         // Domyślny kolor tekstu (Czarny)
            'editorLineNumber.foreground': '#8080FF',
            'editor.lineHighlightBackground': '#130030', // Delikatne wyróżnienie aktywnej linii
            'editorGutter.background': '#130030',
	    'editorCursor.foreground': '#FFFF5F'
        }
    });
let userKeywordDecorations = [];

function highlightUserKeywords() {
    if (!editor || !currentProject) return;
    
    const model = editor.getModel();
    if (!model || model.getLanguageId() !== 'cpp') return;

    // Twoje słowa kluczowe z Code::Blocks
    const userKeywords = [
        'std', 'cout', 'cin', 'cerr', 'endl', 'vector', 'string', 'map', 'set', 'list', 'deque',
        'shared_ptr', 'unique_ptr', 'make_shared', 'make_unique', 'pair', 'tuple', 'ifstream', 'ofstream'
    ];

    const newDecorations = [];
    const text = model.getValue();
    
    // Szukamy pełnych słów za pomocą RegEx
    const regex = new RegExp(`\\b(${userKeywords.join('|')})\\b`, 'g');
    let match;

    while ((match = regex.exec(text)) !== null) {
        const startPos = model.getPositionAt(match.index);
        const endPos = model.getPositionAt(match.index + match[0].length);

        newDecorations.push({
            range: new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
            options: {
                inlineClassName: 'codeblocks-user-keyword' // Nasza klasa CSS
            }
        });
    }

    // Aplikujemy dekoracje do edytora
    userKeywordDecorations = editor.deltaDecorations(userKeywordDecorations, newDecorations);
}
    const editor = monaco.editor.create(document.getElementById('editor-container'), {
        model: blankModel, 
        theme: 'zaibatsu', 
        automaticLayout: true, 
        fontSize: 14, 
        readOnly: true,
        glyphMargin: true, // Ta opcja aktywuje boczny margines na kropki
	'bracketPairColorization.enabled': false
    });
    const tabsContainer = document.getElementById('tabs-container');
    const fileTreeContainer = document.getElementById('file-tree');
    const welcomeModal = document.getElementById('welcome-modal');
    const termOutput = document.getElementById('terminal-output');
    
    // NAPRAWIONE: Poprawne ID elementu z index.html
    const termInput = document.getElementById('terminal-input'); 
    // --- FUNKCJA PRZEŁĄCZANIA / DODAWANIA BREAKPOINTA ---
    function toggleBreakpoint(lineNumber) {
        if (!activeFile) return;

        // Inicjalizuj tablicę dla pliku, jeśli jeszcze nie istnieje
        if (!projectBreakpoints[activeFile]) {
            projectBreakpoints[activeFile] = [];
        }

        const breakpoints = projectBreakpoints[activeFile];
        const existingIndex = breakpoints.findIndex(bp => bp.line === lineNumber);

        if (existingIndex !== -1) {
            // Jeśli breakpoint istnieje -> usuń go
            const removedBp = breakpoints.splice(existingIndex, 1)[0];
            editor.removeDecorations([removedBp.decorationId]);
            console.log(`Breakpoint usunięty z linii ${lineNumber} w pliku ${activeFile}`);
        } else {
            // Jeśli breakpoint nie istnieje -> dodaj dekorację (czerwoną kropkę)
            const decorations = editor.deltaDecorations([], [
                {
                    range: new monaco.Range(lineNumber, 1, lineNumber, 1),
                    options: {
                        isWholeLine: false,
                        glyphMarginClassName: 'monaco-breakpoint-glyph', // Klasa z CSS
                        glyphMarginHoverMessage: { value: 'Breakpoint' }
                    }
                }
            ]);

            breakpoints.push({
                line: lineNumber,
                decorationId: decorations[0]
            });
            console.log(`Breakpoint dodany na linii ${lineNumber} w pliku ${activeFile}`);
// NOWOŚĆ: Jeśli debugujesz na żywo, wyślij komendę natychmiast
            if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN && debugActiveFile) {
                const gdbBreakCmd = `break ${activeFile}:${lineNumber}`;
                terminalSocket.send(JSON.stringify({ type: 'input', data: gdbBreakCmd }));
            }
        }
    }
   // --- FUNKCJA USTAWIANIA STRZAŁKI DEBUGGERA (TERAZ GLOBALNA) ---
window.showDebugLocation = function(filePath, lineNumber) {
    window.currentDebugLineNumber = lineNumber;
    debugActiveFile = filePath;

    // Bezpiecznik: jeśli z jakiegoś powodu plik nie jest aktywny, nie rysujemy na ślepo
    if (activeFile !== filePath) return;

    const newDecorations = [
        {
            range: new monaco.Range(lineNumber, 1, lineNumber, 1),
            options: {
                isWholeLine: true,
                glyphMarginClassName: 'monaco-debug-line-glyph', // Twoja żółta strzałka z CSS
                className: 'monaco-debug-line-background',       // Podświetlenie linii
                glyphMarginHoverMessage: { value: 'Bieżąca linia wykonywania programu' }
            }
        }
    ];

    const oldDecorations = currentDebugLineDecoration ? [currentDebugLineDecoration] : [];
    const decorations = editor.deltaDecorations(oldDecorations, newDecorations);
    
    currentDebugLineDecoration = decorations[0];

    // Automatyczne przewijanie ekranu do linii, w której stoi debugger
    editor.revealLineInCenter(lineNumber);
};

// --- FUNKCJA CZYSZCZENIA STRZAŁKI (TERAZ GLOBALNA) ---
window.clearDebugLocation = function() {
    if (currentDebugLineDecoration) {
        editor.deltaDecorations([currentDebugLineDecoration], []);
        currentDebugLineDecoration = null;
        debugActiveFile = null;
    }
};

    // --- OBSŁUGA KLIKNIĘCIA MYSZKĄ W MARGINES ---
    editor.onMouseDown(function (e) {
        // Sprawdzamy, czy użytkownik kliknął dokładnie w margines ikon (glyph margin)
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            const lineNumber = e.target.position.lineNumber;
            toggleBreakpoint(lineNumber);
        }
    });
    // Uruchom przy każdej zmianie zawartości dokumentu
editor.onDidChangeModelContent(() => {
    highlightUserKeywords();
});

// Uruchom przy zmianie aktywnego pliku
editor.onDidChangeModel(() => {
    highlightUserKeywords();
});

// --- SKRÓTY NAWIGACJI PO KODZIE (Wersja Global-String RegEx) ---
// Mapowanie własnego skrótu klawiszowego na "Go to Definition"
// Przechwytywanie Ctrl + . zanim przeglądarka zdąży na nie zareagować

editor.addAction({
    id: 'custom-go-to-definition-action', // Unikalne ID akcji
    label: 'Idź do definicji (Własny skrót)', // Nazwa widoczna np. w palecie komend (F1)
    
    // Tutaj definiujesz swój nowy skrót klawiszowy
    keybindings: [
       monaco.KeyMod.Alt | monaco.KeyCode.Period // Przykład: Ctrl + . (Kropka)
    ],
    
    precondition: null,
    keybindingContext: null,
    contextMenuGroupId: 'navigation', // Dodaje tę opcję do menu pod prawym przyciskiem myszy
    contextMenuOrder: 1,
    
    run: function(ed) {
        // Wywołujemy natywną akcję Monaco. 
        // Dzięki temu zadziała Twój zarejestrowany DefinitionProvider!
        ed.trigger('keyboard', 'editor.action.revealDefinition', null);
    }
});
// Mapowanie skrótu na "Go to Declaration"
editor.addAction({
    id: 'custom-go-to-declaration-action',
    label: 'Idź do deklaracji',
    keybindings: [
        monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.Period // Alt + Shift + .
    ],
    precondition: null,
    keybindingContext: null,
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 2, // Pojawi się w menu kontekstowym tuż pod definicją
    run: function(ed) {
        // Wywołanie natywnej akcji poszukiwania deklaracji w Monaco
        ed.trigger('keyboard', 'editor.action.revealDeclaration', null);
    }
});
// Rejestracja natywnego dostawcy definicji dla języka C++ w Monaco
monaco.languages.registerDefinitionProvider('cpp', {
    provideDefinition: function(model, position, token) {
        const wordObj = model.getWordAtPosition(position);
        if (!wordObj) return null;

        const targetWord = wordObj.word;

        const regexes = [
            new RegExp(`\\b(?:class|struct)\\s+${targetWord}\\b[^{]*\\{`, 'g'),
            new RegExp(`\\b[\\w\\*&<>:]+\\s+${targetWord}\\s*\\([^)]*\\)[^{]*\\{`, 'g'),
            new RegExp(`\\b[\\w:]*::${targetWord}\\s*\\([^)]*\\)[^{]*\\{`, 'g')
        ];

        for (const [filePath, fileObj] of Object.entries(files)) {
            if (!fileObj || !fileObj.model) continue;
            
            const textContent = fileObj.model.getValue();

            for (const regex of regexes) {
                regex.lastIndex = 0;
                const match = regex.exec(textContent);
                if (match) {
                    const textBeforeMatch = textContent.substring(0, match.index);
                    const linesBefore = textBeforeMatch.split('\n');
                    const lineNumber = linesBefore.length;

                    // NAPRAWIONE: Najpierw zmieniamy plik, a ułamek sekundy później wymuszamy pozycję kursora
                    setTimeout(() => {
                        if (typeof switchToFile === 'function') {
                            switchToFile(filePath);
                        }
                        
                        // Małe opóźnienie (50ms), aby Monaco zdążyło przetrawić zmianę aktywnego modelu
                        setTimeout(() => {
                            editor.setPosition({ lineNumber: lineNumber, column: 1 });
                            editor.revealLineInCenter(lineNumber);
                            editor.focus();
                        }, 50);
                        
                    }, 10);

                    // Zwracamy obiekt lokacji (przydatny m.in. do wstępnego podglądu Peek Definition)
                    return {
                        uri: fileObj.model.uri,
                        range: new monaco.Range(lineNumber, 1, lineNumber, 1)
                    };
                }
            }
        }
        return null;
    }
});
// Rejestracja natywnego dostawcy DEKLARACJI dla języka C++ w Monaco
monaco.languages.registerDeclarationProvider('cpp', {
    provideDeclaration: function(model, position, token) {
        const wordObj = model.getWordAtPosition(position);
        if (!wordObj) return null;

        const targetWord = wordObj.word;

        // RegExy specyficzne dla DEKLARACJI (szukamy struktur zakończonych średnikiem)
        const regexes = [
            // 1. Prototyp / deklaracja funkcji (np. void funkcja(int a);)
            new RegExp(`\\b[\\w\\*&<>:]+\\s+${targetWord}\\s*\\([^)]*\\)\\s*;`, 'g'),
            
            // 2. Deklaracja wyprzedzająca klasy lub struktury (np. class MojaKlasa;)
            new RegExp(`\\b(?:class|struct)\\s+${targetWord}\\s*;`, 'g'),
            
            // 3. Deklaracja zmiennej globalnej typu extern (np. extern int licznik;)
            new RegExp(`\\bextern\\s+[\\w\\*&<>:]+\\s+${targetWord}\\s*;`, 'g')
        ];

        for (const [filePath, fileObj] of Object.entries(files)) {
            if (!fileObj || !fileObj.model) continue;
            
            const textContent = fileObj.model.getValue();

            for (const regex of regexes) {
                regex.lastIndex = 0;
                const match = regex.exec(textContent);
                if (match) {
                    const textBeforeMatch = textContent.substring(0, match.index);
                    const linesBefore = textBeforeMatch.split('\n');
                    const lineNumber = linesBefore.length;

                    // Identyczna bezpieczna mechanika przełączania pliku i ustawiania kursora
                    setTimeout(() => {
                        if (typeof switchToFile === 'function') {
                            switchToFile(filePath);
                        }
                        
                        setTimeout(() => {
                            editor.setPosition({ lineNumber: lineNumber, column: 1 });
                            editor.revealLineInCenter(lineNumber);
                            editor.focus();
                        }, 50);
                        
                    }, 10);

                    return {
                        uri: fileObj.model.uri,
                        range: new monaco.Range(lineNumber, 1, lineNumber, 1)
                    };
                }
            }
        }
        return null; // Jeśli nie znaleziono deklaracji
    }
});
// --- REJESTRACJA SKRÓTU F2 W MONACO ---
    editor.addCommand(monaco.KeyCode.F2, function() {
        const position = editor.getPosition();
        if (position) {
            toggleBreakpoint(position.lineNumber);
        }
    });
      // --- Global Project Compiler Engine (Dynamic Multi-File Parsing) ---
    async function compileAndRunProject() {
        if (!currentProject) {
            termOutput.innerHTML += `\n<span style="color: #ffaa00;">⚠️ Please load or create a project workspace first.</span>`;
            termOutput.scrollTop = termOutput.scrollHeight;
            return;
        }

        saveCurrentFile();

        termOutput.innerHTML += `\n<span style="color: #007acc;">⚙️ [F9] Reading project layout configuration...</span>`;
        termOutput.scrollTop = termOutput.scrollHeight;

        let includeFlag = "-I include"; 
        let sourceDir = "src"; 
        let targetFlag = "-g"; 
        let buildMode = "debug";
        let sourcePathLog = "fallback defaults";
	let libsFlag = "";
	let libDirFlag = "-L lib";
        const pjtKey = `${currentProject}.pjt`;

        if (files[pjtKey]) {
            try {
                const rawContent = files[pjtKey].model ? files[pjtKey].model.getValue() : files[pjtKey];
                const pjtData = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
                
                const targetInclude = pjtData["include_dir"] || pjtData["include dir"] || pjtData["includeDir"];
                if (targetInclude) {
                    includeFlag = `-I "${targetInclude}"`;
                }

                const targetSource = pjtData["source_dir"] || pjtData["source dir"] || pjtData["sourceDir"];
                if (targetSource) {
                    sourceDir = targetSource.replace(/^\.\//, ''); 
                }
		const targetLibDir = pjtData["library_dir"] || pjtData["library dir"] || pjtData["libraryDir"];
                if (targetLibDir) {
                    libDirFlag = `-L "${targetLibDir}"`;
                }
                if (pjtData["target"]) {
                    buildMode = pjtData["target"].toLowerCase().trim();
                    if (buildMode === "release") {
                        targetFlag = "-O3"; 
                    } else {
                        targetFlag = "-g";  
                        buildMode = "debug"; 
                    }
                }
                const targetLibs = pjtData["link_libraries"] || pjtData["link libraries"] || pjtData["linkLibraries"];
                if (targetLibs) {
                    if (Array.isArray(targetLibs)) {
                        libsFlag = targetLibs.map(lib => lib.startsWith('-l') ? lib : `-l${lib}`).join(' ');
                    } else if (typeof targetLibs === 'string' && targetLibs.trim() !== "") {
                        libsFlag = targetLibs.trim().split(/\s+/).map(lib => lib.startsWith('-l') ? lib : `-l${lib}`).join(' ');
                    }
                }
                sourcePathLog = `.pjt config (src: "${sourceDir}", include: "${targetInclude || 'include'}", mode: "${buildMode}")`;
            } catch (e) {
                console.warn("Could not parse .pjt layout config.", e);
            }
        }

        termOutput.innerHTML += `\n<span style="color: #858585;">ℹ️ Layout tracking: using ${sourcePathLog}</span>`;

        // NAPRAWIONE: Tworzenie outputu o nazwie projektu w cudzysłowie (obsługa spacji)
        const compileCmd = `g++ ${targetFlag} ${includeFlag} ${libDirFlag} ${sourceDir}/*.cpp -o "${currentProject}" ${libsFlag}`.trim();

	// NAPRAWIONE: Zamiast "process.platform" (błąd), używamy bezpiecznego dla przeglądarki navigator.userAgent
        const isWindows = navigator.userAgent.toLowerCase().includes('win');
        const executeCmd = isWindows ? `"${currentProject}"` : `./"${currentProject}"`;

        try {
            const compileRes = await fetch('http://localhost:5000/api/terminal/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectName: currentProject, command: compileCmd })
            });
            const compileData = await compileRes.json();

            if (compileData.success && compileData.exitCode === 0) {
                termOutput.innerHTML += `\n<span style="color: #73c991;">✔ All source targets built successfully! Executing target binary...</span>`;
                
                if (compileData.stderr) {
                    termOutput.innerHTML += `\n<span style="color: #ffaa00;">${compileData.stderr}</span>`;
                }

                const runRes = await fetch('http://localhost:5000/api/terminal/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectName: currentProject, command: executeCmd })
                });
                const runData = await runRes.json();

                if (runData.success) {
                    if (runData.stdout) termOutput.innerHTML += `\n<span style="color: #ffffff;">${runData.stdout}</span>`;
                    if (runData.stderr) termOutput.innerHTML += `\n<span style="color: #f48771;">${runData.stderr}</span>`;
                }
            } else {
                termOutput.innerHTML += `\n<span style="color: #f48771;">❌ Compilation Failed:</span>`;
                if (compileData.stderr) termOutput.innerHTML += `\n<span style="color: #f48771;">${compileData.stderr}</span>`;
            }
        } catch (err) {
            termOutput.innerHTML += `\n<span style="color: #ff3333;">Compilation execution request failed to send.</span>`;
        }

        termOutput.scrollTop = termOutput.scrollHeight;
    }

    // --- Debugger Engine (Zsynchronizowany z układem .pjt jak przy F9) ---
    async function startGdbDebugger() {
        if (!currentProject) {
            alert("Please load a project first.");
            return;
        }
        
        saveCurrentFile();
        termOutput.innerHTML += `\n<span style="color: #007acc;">⚙️ [F8] Reading project layout configuration for debugging...</span>`;
        termOutput.scrollTop = termOutput.scrollHeight;

        // Domyślne wartości (takie same jak przy F9)
        let includeFlag = "-I include"; 
        let sourceDir = "src"; 
        let sourcePathLog = "fallback defaults";
	let libsFlag = "";
	let libDirFlag = "-L lib";
        const pjtKey = `${currentProject}.pjt`;

        // Dynamiczne wyciąganie ścieżek z pliku konfiguracyjnego projektu .pjt
        if (files[pjtKey]) {
            try {
                const rawContent = files[pjtKey].model ? files[pjtKey].model.getValue() : files[pjtKey];
                const pjtData = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
                
                const targetInclude = pjtData["include_dir"] || pjtData["include dir"] || pjtData["includeDir"];
                if (targetInclude) {
                    includeFlag = `-I "${targetInclude}"`;
                }

                const targetSource = pjtData["source_dir"] || pjtData["source dir"] || pjtData["sourceDir"];
                if (targetSource) {
                    sourceDir = targetSource.replace(/^\.\//, ''); 
                }
		const targetLibDir = pjtData["library_dir"] || pjtData["library dir"] || pjtData["libraryDir"];
                if (targetLibDir) {
                    libDirFlag = `-L "${targetLibDir}"`;
                }
               const targetLibs = pjtData["link_libraries"] || pjtData["link libraries"] || pjtData["linkLibraries"];
                if (targetLibs) {
                    if (Array.isArray(targetLibs)) {
                        libsFlag = targetLibs.map(lib => lib.startsWith('-l') ? lib : `-l${lib}`).join(' ');
                    } else if (typeof targetLibs === 'string' && targetLibs.trim() !== "") {
                        libsFlag = targetLibs.trim().split(/\s+/).map(lib => lib.startsWith('-l') ? lib : `-l${lib}`).join(' ');
                    }
                }                sourcePathLog = `.pjt config (src: "${sourceDir}", include: "${targetInclude || 'include'}", mode: "debug")`;
            } catch (e) {
                console.warn("Could not parse .pjt layout config.", e);
            }
        }

        termOutput.innerHTML += `\n<span style="color: #858585;">ℹ️ Debug layout tracking: using ${sourcePathLog}</span>`;

        // Dynamicznie zbudowana komenda kompilacji z wymuszoną flagą -g do debugowania
	const compileCmd = `g++ -g ${includeFlag} ${libDirFlag} ${sourceDir}/*.cpp -o "${currentProject}" ${libsFlag}`.trim();
        const response = await fetch('http://localhost:5000/api/terminal/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: currentProject, command: compileCmd })
        });
        const data = await response.json();

        if (data.success && data.exitCode === 0) {
            termOutput.innerHTML += `\n<span style="color: #73c991;">✅ Build OK. Injecting GDB session...</span>\n`;
            
            if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
               const isWindows = navigator.userAgent.toLowerCase().includes('win');
                
                // Uciszamy debuginfod i pagynację od razu przy starcie, ale NIE odpalamy jeszcze 'run'
               const gdbArgs = '-q -ex "set debuginfod enabled off" -ex "set pagination off"';
const gdbTarget = isWindows ? `gdb ${gdbArgs} "${currentProject}"` : `TERM=dumb gdb ${gdbArgs} ./"${currentProject}"`;                
                // 1. Uruchamiamy GDB z wyciszonymi promptami
                terminalSocket.send(JSON.stringify({ type: 'input', data: gdbTarget }));

                // 2. Czekamy chwilę na załadowanie symboli, wysyłamy kropki, a na końcu odpalamy program
                setTimeout(() => {
                    termOutput.innerHTML += `\n<span style="color: #bc74c4;">🔮 [Debugger] Syncing active breakpoints...</span>`;
                    
                    let breakpointCount = 0;

                    // Przechodzimy po wszystkich plikach i ich liniach, gdzie są breakpointy
                    Object.keys(projectBreakpoints).forEach(filePath => {
                        const breakpoints = projectBreakpoints[filePath] || [];
                        breakpoints.forEach(bp => {
                            const gdbBreakCmd = `break ${filePath}:${bp.line}`;
                            terminalSocket.send(JSON.stringify({ type: 'input', data: gdbBreakCmd }));
                            breakpointCount++;
                        });
                    });

                    termOutput.innerHTML += `\n<span style="color: #858585;">ℹ️ Sent ${breakpointCount} breakpoint(s) to GDB.</span>`;
                    
                    // --- KLUCZOWA ZMIANA: 'run' leci DOPIERO TUTAJ, zaraz po breakpointach ---
                    termOutput.innerHTML += `\n<span style="color: #73c991;">🚀 [Debugger] Starting execution ('run')...</span>\n`;
                    terminalSocket.send(JSON.stringify({ type: 'input', data: 'run' }));

                }, 400);
            }
        } else {
            termOutput.innerHTML += `\n<span style="color: #ff3333;">❌ Compilation failed.</span>`;
            if (data.stderr) termOutput.innerHTML += `\n<span style="color: #f48771;">${data.stderr}</span>`;
        }
        termOutput.scrollTop = termOutput.scrollHeight;

	// 2. NAPRAWA INTERFEJSU: Pozwalamy, aby klasa CSS sterowała wszystkim
            const sidebar = document.getElementById('sidebar');
            const aiSidebar = document.getElementById('ai-sidebar');
            const watchesPanel = document.getElementById('watches-panel');
            const callstackPanel = document.getElementById('callstack-panel');

            // Usuwamy twarde nadpisania stylów, które zablokowały widoki
            if (aiSidebar) aiSidebar.style.removeProperty('display');
            if (watchesPanel) watchesPanel.style.removeProperty('display');
            if (callstackPanel) callstackPanel.style.removeProperty('display');

            // Wyłączamy tryb debugowania – to automatycznie pokaże AI i ukryje zegary przez arkusz CSS!
            if (sidebar) {
                sidebar.classList.remove('debug-mode');
            }    // 3. Czyszczenie UI za pomocą Twojej wbudowanej funkcji globalnej
    
    }
    // --- FUNKCJA POMOCNICZA DO STEROWANIA GDB PRZEZ SKRÓTY KLAWISZOWE ---
function sendGdbCommand(commandText) {
    if (!terminalSocket || terminalSocket.readyState !== WebSocket.OPEN) {
        console.warn("GDB command ignored: WebSocket is not open.");
        return;
    }
    
    // Resetujemy flagi parsera i zapowiadamy, że właśnie wykonujemy krok kodu
    window.gdbStepJustHappened = true; 
    window.gdbSilentlyFetchingBt = false;
    window.gdbSilentlyFetchingWatch = false;
    
    // Wysyłamy komendę bezpośrednio do sesji terminala pty procesu GDB
    terminalSocket.send(JSON.stringify({ type: 'input', data: commandText }));
}

function stopGdbDebugger() {
    console.log("Stopping debug session and forcing GDB quit...");
    
    // 1. Wysyłamy quit, jeśli gdb i socket działają
    if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
        sendGdbCommand('quit');
        
        // 2. Automatycznie wysyłamy 'y' po krótkiej chwili na monit "Kill it?"
        setTimeout(() => {
            if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
                terminalSocket.send(JSON.stringify({ type: 'input', data: 'y\r\n' }));
            }
        }, 100);
    }


// --- ZAKTUALIZOWANA, NIEZAWODNA SEKCJA UI ---
            const sidebar = document.getElementById('sidebar');
            if (sidebar) {
                sidebar.classList.remove('debug-mode');
            }

            const aiSidebar = document.getElementById('ai-sidebar');
            const watchesPanel = document.getElementById('watches-panel');
            const callstackPanel = document.getElementById('callstack-panel');
	    const debugSidebar = document.getElementById('debug-sidebar');
            if (aiSidebar) aiSidebar.style.display = 'flex';       // Pokazuje AI po zakończeniu
            if (watchesPanel) watchesPanel.style.display = 'none';   // Chowa zegary
            if (callstackPanel) callstackPanel.style.display = 'none'; // Chowa callstack
	    if (debugSidebar) debugSidebar.style.display = 'none';
	if (window.clearDebugLocation) {
        window.clearDebugLocation();
    }
    
    // 4. Czyszczenie listy Call Stack w interfejsie
    const callstackList = document.getElementById('callstack-list');
    if (callstackList) {
        callstackList.innerHTML = '<span style="color: #6a9955; font-style: italic; padding: 10px; display: block;">No active frames.</span>';
    }

    // 5. Resetowanie flag i stanów wewnętrznych aplikacji
    debugActiveFile = null;
    window.currentDebugLineNumber = null;
    window.gdbStepJustHappened = false;
    
    // Opcjonalnie: odblokowanie edytora
    editor.updateOptions({ readOnly: false });
}

    function detectLanguage(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        if (ext === 'pjt') return 'json';
        if (ext === 'cpp' || ext === 'cc' || ext === 'hpp') return 'cpp';
        if (ext === 'c' || ext === 'h') return 'c';
        return 'plaintext';
    }

    function saveCurrentFile() {
        if (!activeFile || !currentProject) return;

        const safeId = activeFile.replace(/\//g, '-').replace(/\./g, '-');
        const indicator = document.getElementById(`status-${safeId}`);

        if (indicator) {
            indicator.innerText = " ⏳";
            indicator.style.color = "#ffaa00";
        }

        fetch('http://localhost:5000/api/file/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectName: currentProject,
                filePath: activeFile,
                content: editor.getValue()
            })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success && indicator) {
                indicator.innerText = " ✔";
                indicator.style.color = "#73c991";
                setTimeout(() => {
                    if (indicator) indicator.innerText = "";
                }, 2000);
            }
        })
        .catch(err => {
            if (indicator) {
                indicator.innerText = " ❌";
                indicator.style.color = "#f48771";
            }
        });
    }

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function() {
        saveCurrentFile();
    });
    // Skrót Alt + 5 wewnątrz edytora Monaco
editor.addAction({
    id: 'focus-callstack',
    label: 'Focus Call Stack',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Digit5],
    run: function() {
        const callstackPanel = document.getElementById('callstack-panel');
        if (callstackPanel) {
            callstackPanel.focus();
            // Opcjonalnie: dodaj efekt wizualny (np. delikatną ramkę), żeby było widać focus
            callstackPanel.style.outline = '1px solid #569cd6';
            setTimeout(() => callstackPanel.style.outline = 'none', 500);
        }
    }
});
// Rejestrujemy akcję pod skrótem Ctrl + . (Go to Definition/Declaration)
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period, function() {
    console.log("🎯 WYMUSZONY SKRÓT ZADZIAŁAŁ!");
    
    const position = editor.getPosition();
    const model = editor.getModel();
    const wordObj = model.getWordAtPosition(position);
    
    if (!wordObj) {
            console.warn("Brak słowa pod kursorem.");
            return;
        }

        const targetWord = wordObj.word;
        console.log(`Szukam definicji/deklaracji dla: ${targetWord}...`);

        // Zestaw "mądrzejszych" RegExów dopasowanych do specyfiki C/C++
        const regexes = [
            // 1. Definicja klasy lub struktury (np. "class MyClass {" lub "struct MyStruct : Base {")
            new RegExp(`(?:class|struct)\\s+${targetWord}\\s*(?::[^{]+)?\\{`),
            
            // 2. Definicja funkcji / metody (np. "int myFunc(int a) {" lub "void myFunc() const {")
            new RegExp(`(?:[\\w\\*&<>:]+\\s+)+${targetWord}\\s*\\([^)]*\\)\\s*(?:const)?\\s*\\{`),
            
            // 3. Implementacja metody poza klasą (np. "MyClass::myMethod(...) {")
            new RegExp(`[\\w:]*::${targetWord}\\s*\\([^)]*\\)\\s*(?:const)?\\s*(?::[^{]+)?\\{`),
            
            // 4. Deklaracja funkcji (zakończona średnikiem, np. "void myFunc();")
            new RegExp(`(?:[\\w\\*&<>:]+\\s+)+${targetWord}\\s*\\([^)]*\\)\\s*(?:const)?\\s*;`),
            
            // 5. Deklaracja zmiennej globalnej/lokalnej (np. "int myVar;" lub "auto* myVar =")
            new RegExp(`(?:[\\w\\*&<>:]+\\s+)+${targetWord}\\s*(?:=|;)`)
        ];

        let found = false;

    // Przeszukiwanie Twojego lokalnego słownika plików w pamięci frontendu
    for (const [filePath, fileContent] of Object.entries(files)) {
        // 1. BEZPIECZEŃSTWO: Pomijamy puste pliki
        if (!fileContent) continue;

        // 2. BEZPIECZEŃSTWO: Jeśli backend przekazał obiekt zamiast stringa (np. { content: "kod..." })
        let textContent = "";
        if (typeof fileContent === 'string') {
            textContent = fileContent;
        } else if (typeof fileContent === 'object' && fileContent.content) {
            textContent = fileContent.content;
        } else {
            // Jeśli to jakiś inny dziwny format struktury, przejdź do następnego pliku
            continue; 
        }

        // Teraz bezpiecznie dzielimy tekst na linie
        const lines = textContent.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const regex of regexes) {
                if (regex.test(line)) {
                    console.log(`Znalazłem dopasowanie dla '${targetWord}' w pliku ${filePath} w linii ${i + 1}`);

                    // Wywołanie Twojej funkcji zmieniającej aktywny plik w IDE
                    if (typeof switchToFile === 'function') {
                        switchToFile(filePath);
                    }

                    setTimeout(() => {
                        const column = line.indexOf(targetWord) + 1;
                        editor.setPosition({ lineNumber: i + 1, column: column > 0 ? column : 1 });
                        editor.revealLineInCenter(i + 1);
                        editor.focus();
                    }, 50);

                    found = true;
                    break;
                }
            }
            if (found) break;
        }
        if (found) break;
    }

        if (!found) {
            // Opcjonalny fallback: po prostu poszukaj słowa gdziekolwiek, jeśli nie znaleziono definicji
            console.warn(`Nie udało się znaleźć precyzyjnej definicji dla: ${targetWord}`);
        }
});

    window.addEventListener('keydown', function(e) {
        if (e.key === 'F9') {
            e.preventDefault(); 
            compileAndRunProject();
        }
        
        if (e.key === 'F8') {
            e.preventDefault();
            e.stopPropagation();
            startGdbDebugger();
        }
	// --- SEKCJA INTERAKTYWNEGO STEROWANIA DEBUGGEREM (F3 - F7) ---
        // Blokujemy i przechwytujemy te klawisze tylko wtedy, gdy sesja GDB rzeczywiście trwa   
	if (e.altKey && (e.key === '4' || e.keyCode === 52)) {
        
        console.log("🎯 Przechwycono Alt + 4 – przenoszę focus na Watches");
        
        e.preventDefault();  // Blokujemy ewentualne akcje przeglądarki lub Monaco
        e.stopPropagation(); // Blokujemy dotarcie skrótu do panelu AI

        const watchesPanel = document.getElementById('watches-panel');
        if (watchesPanel) {
            watchesPanel.focus();
            
            // Opcjonalnie: wizualne wyróżnienie (np. dodanie tymczasowego borderu), żeby użytkownik wiedział, że panel jest aktywny
            watchesPanel.style.outline = "1px solid #569cd6";
            
            // Usuwamy obwódkę focusu, gdy użytkownik kliknie gdzieś indziej
            watchesPanel.addEventListener('blur', function() {
                watchesPanel.style.outline = "none";
            }, { once: true });
        }
    }
        if (debugActiveFile) {
            if (e.key === 'F3') {
                e.preventDefault();
                e.stopPropagation();
                sendGdbCommand('step');
            }
            if (e.key === 'F4') {
                e.preventDefault();
                e.stopPropagation();
                sendGdbCommand('next');
            }
            if (e.key === 'F6') {
                e.preventDefault();
                e.stopPropagation();
                sendGdbCommand('continue');
            }
            if (e.key === 'F7') {
                e.preventDefault();
                e.stopPropagation();
                stopGdbDebugger();
            }
        }    
        
        if (e.altKey && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            e.stopPropagation();
            createNewFileInWorkspace();
        }
	if (e.altKey && e.key.toLowerCase() === 'w') {
            e.preventDefault();
            e.stopPropagation();
            promptAddWatchVariable();
        }    

        if (e.altKey && e.key === '1') {
            e.preventDefault();
            const fileTree = document.getElementById('file-tree');
            if (fileTree) {
                if (!fileTree.hasAttribute('tabindex')) {
                    fileTree.setAttribute('tabindex', '0');
                }
                fileTree.focus();
                
                const clickableItems = Array.from(fileTree.querySelectorAll('.tree-item-container'));
                clickableItems.forEach(item => item.classList.remove('active-tree-item'));

                if (activeFile) {
                    const currentFileName = activeFile.split('/').pop();
                    const activeItem = clickableItems.find(item => item.textContent.trim().includes(currentFileName));
                    if (activeItem) {
                        activeItem.classList.add('active-tree-item');
                        activeItem.scrollIntoView({ block: 'nearest' });
                    } else if (clickableItems.length > 0) {
                        clickableItems[0].classList.add('active-tree-item');
                    }
                } else if (clickableItems.length > 0) {
                    clickableItems[0].classList.add('active-tree-item');
                }
            }
        }

        if (e.altKey && e.key === '2') {
            e.preventDefault();
            editor.focus();
        }

        if (e.altKey && e.key === '3') {
            e.preventDefault();
            if (termInput) termInput.focus();
        }

        if (e.altKey && e.key === '4') {
            e.preventDefault();
            const chatInput = document.getElementById('chat-input');
            if (chatInput) chatInput.focus();
        }
	// Wewnątrz istniejącego window.addEventListener('keydown', ...)
if (e.altKey && e.key === '5') {
    e.preventDefault();
    const callstackPanel = document.getElementById('callstack-panel');
    if (callstackPanel) {
        callstackPanel.focus();
        
        // Efekt wizualny mignięcia ramki
        callstackPanel.style.outline = '1px solid #569cd6';
        setTimeout(() => callstackPanel.style.outline = 'none', 500);
    }
}
        // --- OBSŁUGA STRZAŁEK W DRZEWIE PLIKÓW ---
        if (document.activeElement === document.getElementById('file-tree')) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                
                const fileTree = document.getElementById('file-tree');
                const clickableItems = Array.from(fileTree.querySelectorAll('.tree-item-container'));
                if (clickableItems.length === 0) return;

                let currentIndex = clickableItems.findIndex(item => item.classList.contains('active-tree-item'));
                
                let nextIndex = currentIndex;
                if (e.key === 'ArrowDown') {
                    nextIndex = (currentIndex + 1 < clickableItems.length) ? currentIndex + 1 : 0;
                } else if (e.key === 'ArrowUp') {
                    nextIndex = (currentIndex - 1 >= 0) ? currentIndex - 1 : clickableItems.length - 1;
                }

                const targetItem = clickableItems[nextIndex];
                if (targetItem) {
                    const matchedPath = targetItem.getAttribute('data-path');
                    
                    if (matchedPath && files[matchedPath]) {
                        switchToFile(matchedPath);
                        
                        setTimeout(() => {
                            fileTree.focus();
                            const newActiveItem = fileTree.querySelector(`[data-path="${matchedPath}"]`);
                            if (newActiveItem) {
                                fileTree.querySelectorAll('.tree-item-container').forEach(item => item.classList.remove('active-tree-item'));
                                newActiveItem.classList.add('active-tree-item');
                                newActiveItem.scrollIntoView({ block: 'nearest' });
                            }
                        }, 15);
                    }
                }
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                editor.focus();
            }

            if (e.key === 'Delete' || e.key === 'Del') {
                e.preventDefault();
                e.stopPropagation();
                if (activeFile) {
                    deleteFileFromWorkspace(activeFile);
                }
            }
        }

	    // --- NAPRAWIONE: SEKCJA WYBIERANIA FUNKCJI STRZAŁKAMI W CALL STACKU (TERAZ CAŁKOWICIE OSOBNO) ---
        const callstackPanel = document.getElementById('callstack-panel');
        if (document.activeElement === callstackPanel || (callstackPanel && callstackPanel.contains(document.activeElement))) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                
                const clickableItems = Array.from(callstackPanel.querySelectorAll('.callstack-item'));
                if (clickableItems.length === 0) return;

                // Szukamy indeksu aktualnie zaznaczonej pozycji
                let currentIndex = clickableItems.findIndex(item => item.classList.contains('active-callstack-item'));
                
                let nextIndex = currentIndex;
                if (e.key === 'ArrowDown') {
                    nextIndex = (currentIndex + 1 < clickableItems.length) ? currentIndex + 1 : 0;
                } else if (e.key === 'ArrowUp') {
                    nextIndex = (currentIndex - 1 >= 0) ? currentIndex - 1 : clickableItems.length - 1;
                }

                const targetItem = clickableItems[nextIndex];
                if (targetItem) {
                    // 1. Czyścimy poprzednie zaznaczenia wizualne
                    clickableItems.forEach(item => {
                        item.classList.remove('active-callstack-item');
                        item.style.backgroundColor = 'transparent';
                    });

                    // 2. Nadajemy klasę i tło nowo wybranej ramce stosu
                    targetItem.classList.add('active-callstack-item');
                    targetItem.style.backgroundColor = '#37373d';
                    targetItem.scrollIntoView({ block: 'nearest' });
                    
                    // 3. Bezpieczny skok za pomocą zbindowanych zmiennych wewnętrznych
                    if (targetItem.__targetPath && targetItem.__lineNum) {
                        const tPath = targetItem.__targetPath;
                        const lNum = targetItem.__lineNum;
                        
                        if (activeFile !== tPath) {
                            switchToFile(tPath);
                        }
                        
                        setTimeout(() => {
                            if (window.showDebugLocation) {
                                window.showDebugLocation(tPath, lNum);
                            } else {
                                editor.setPosition({ lineNumber: lNum, column: 1 });
                                editor.revealLineInCenter(lNum);
                            }
                            // KLUCZOWE: Wymuszamy zachowanie skupienia w panelu stosu!
                            callstackPanel.focus();
                        }, 50);
                    } else {
                        // Awaryjny fallback
                        targetItem.click();
                        setTimeout(() => { callstackPanel.focus(); }, 70);
                    }
                }
            }

            // Klawisz Enter przenosi nas bezpośrednio do pisania kodu w Monaco Editor
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                editor.focus();
            }
        }
    }, { capture: true });

    function syncWorkspaceUI() {
        tabsContainer.innerHTML = '';
        fileTreeContainer.innerHTML = '';

        const groups = { root: [], src: [], include: [] };

        Object.keys(files).forEach(filePath => {
            if (filePath.startsWith('src/')) {
                groups.src.push(filePath);
            } else if (filePath.startsWith('include/')) {
                groups.include.push(filePath);
            } else {
                groups.root.push(filePath);
            }
        });

        function createFolderHeader(name) {
            const folderDiv = document.createElement('div');
            folderDiv.style.padding = '6px 10px';
            folderDiv.style.fontSize = '12px';
            folderDiv.style.fontWeight = 'bold';
            folderDiv.style.color = '#858585';
            folderDiv.style.display = 'flex';
            folderDiv.style.alignItems = 'center';
            folderDiv.style.textTransform = 'uppercase';
            folderDiv.style.letterSpacing = '0.5px';
            folderDiv.innerHTML = `📁 <span style="margin-left: 6px;">${name}</span>`;
            fileTreeContainer.appendChild(folderDiv);
        }

        function renderFileItem(filePath, indent = false) {
            const isProjectFile = filePath.endsWith('.pjt');
            const safeId = filePath.replace(/\//g, '-').replace(/\./g, '-');
            const fileName = filePath.split('/').pop();

            const treeDiv = document.createElement('div');
            treeDiv.className = `tree-item tree-item-container ${filePath === activeFile ? 'active active-tree-item' : ''}`;
            treeDiv.setAttribute('data-path', filePath);
            treeDiv.style.display = 'flex';
            treeDiv.style.justifyContent = 'space-between';
            treeDiv.style.alignItems = 'center';
            treeDiv.style.padding = '4px 8px';
            treeDiv.style.paddingLeft = indent ? '24px' : '12px';
            treeDiv.style.cursor = 'pointer';

            const fileInfo = document.createElement('div');
            fileInfo.style.display = 'flex';
            fileInfo.style.alignItems = 'center';
            fileInfo.innerHTML = `${isProjectFile ? '⚙️' : '📄'} <span style="margin-left: 6px; ${isProjectFile ? 'color: #ffaa00;' : ''}">${fileName}</span>`;
            treeDiv.appendChild(fileInfo);

            const rightSideActions = document.createElement('div');
            rightSideActions.style.display = 'flex';
            rightSideActions.style.alignItems = 'center';
            rightSideActions.style.gap = '8px';

            const statusSpan = document.createElement('span');
            statusSpan.id = `status-${safeId}`;
            statusSpan.style.fontSize = '11px';
            statusSpan.style.fontWeight = 'bold';
            rightSideActions.appendChild(statusSpan);

            const deleteBtn = document.createElement('span');
            deleteBtn.className = 'tree-delete-btn';
            deleteBtn.innerHTML = '🗑️';
            deleteBtn.title = 'Delete file permanently (DEL)';
            
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation(); 
                deleteFileFromWorkspace(filePath);
            });
            rightSideActions.appendChild(deleteBtn);
            treeDiv.appendChild(rightSideActions);
            
            treeDiv.addEventListener('click', () => {
                switchToFile(filePath);
                document.querySelectorAll('.tree-item-container').forEach(n => n.classList.remove('active-tree-item'));
                treeDiv.classList.add('active-tree-item');
            });

            fileTreeContainer.appendChild(treeDiv);
        }

        groups.root.forEach(file => renderFileItem(file, false));

        if (groups.src.length > 0) {
            createFolderHeader('src');
            groups.src.forEach(file => renderFileItem(file, true));
        }

        if (groups.include.length > 0) {
            createFolderHeader('include');
            groups.include.forEach(file => renderFileItem(file, true));
        }

        Object.keys(files).forEach(filePath => {
            const isProjectFile = filePath.endsWith('.pjt');
            const fileName = filePath.split('/').pop();

            const tabBtn = document.createElement('button');
            tabBtn.innerText = fileName;
            tabBtn.style.padding = '0 15px'; 
            tabBtn.style.height = '100%'; 
            tabBtn.style.border = 'none'; 
            tabBtn.style.cursor = 'pointer';
            tabBtn.style.backgroundColor = filePath === activeFile ? '#1e1e1e' : '#2d2d2d';
            tabBtn.style.color = filePath === activeFile ? (isProjectFile ? '#ffaa00' : '#ffffff') : '#969696';
            tabBtn.style.borderRight = '1px solid #252526';
            tabBtn.addEventListener('click', () => switchToFile(filePath));
            tabsContainer.appendChild(tabBtn);
        });
    }

    function switchToFile(filePath) {
        if (activeFile) {
            saveCurrentFile(); 
        }
        activeFile = filePath;
        editor.updateOptions({ readOnly: false });
        editor.setModel(files[filePath].model);

        // ODTWORZENIE WIZUALNE BREAKPOINTÓW DLA NOWEGO PLIKU:
        if (projectBreakpoints[activeFile]) {
            const currentBps = projectBreakpoints[activeFile];
            
            // Czyścimy stare (na wypadek glitchu) i nakładamy aktualne dekoracje na model
            currentBps.forEach((bp, index) => {
                const newDecorations = editor.deltaDecorations([], [
                    {
                        range: new monaco.Range(bp.line, 1, bp.line, 1),
                        options: {
                            isWholeLine: false,
                            glyphMarginClassName: 'monaco-breakpoint-glyph',
                            glyphMarginHoverMessage: { value: 'Breakpoint' }
                        }
                    }
                ]);
                currentBps[index].decorationId = newDecorations[0]; // Aktualizujemy ID dekoracji dla nowego widoku
            });
        }
	// ODTWORZENIE STRZAŁKI DEBUGGERA PRZY ZMIANIE PLIKU:
    if (debugActiveFile === filePath && currentDebugLineDecoration) {
        if (window.currentDebugLineNumber) {
            window.showDebugLocation(filePath, window.currentDebugLineNumber);
        }
    }    

    syncWorkspaceUI();
}

    document.getElementById('modal-submit-btn').addEventListener('click', async () => {
        const inputEl = document.getElementById('modal-project-input');
        const name = inputEl ? inputEl.value.trim() : '';
        
        if (!name) {
            alert("Please enter a valid project name.");
            return;
        }

        try {
            const openRes = await fetch('http://localhost:5000/api/project/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectName: name })
            });
            const openData = await openRes.json();

            if (openData.success) {
                initTerminalSocket(name);
                currentProject = name;

                Object.keys(files).forEach(key => delete files[key]);

                Object.keys(openData.files).forEach(filePath => {
                    const content = openData.files[filePath];
                    const lang = detectLanguage(filePath);
                    
                    files[filePath] = {
                        model: monaco.editor.createModel(content, lang)
                    };
                });

                welcomeModal.style.display = 'none';
                if (inputEl) inputEl.value = ''; 

                if (files['src/main.cpp']) {
                    switchToFile('src/main.cpp');
                } else if (Object.keys(files).length > 0) {
                    switchToFile(Object.keys(files)[0]);
                } else {
                    syncWorkspaceUI();
                }
                return;
            }

            const createRes = await fetch('http://localhost:5000/api/project/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectName: name })
            });
            const createData = await createRes.json();

            if (createData.success) {
                initTerminalSocket(name);
                currentProject = name;
                
                files[`${name}.pjt`] = {
                    model: monaco.editor.createModel(JSON.stringify({ 
                        project_name: name, 
                        target: "debug", 
                        source_dir: "./src", 
                        include_dir: "./include", 
			library_dir: "./lib",
                        link_libraries: "" 
                    }, null, 4), 'json')
                };
                files['src/main.cpp'] = {
                    model: monaco.editor.createModel(`#include <iostream>\n\nint main() {\n    std::cout << "Physical C++ Workspace Loaded!" << std::endl;\n    return 0;\n}\n`, 'cpp')
                };

                welcomeModal.style.display = 'none';
                if (inputEl) inputEl.value = ''; 
                switchToFile('src/main.cpp');
            } else {
                alert(`Could not create workspace: ${createData.error}`);
            }

        } catch (err) {
            console.error(err);
            alert("Could not connect to the backend filesystem layout.");
        }
    });

    document.getElementById('modal-project-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('modal-submit-btn').click();
        }
    });    

    function createNewFileInWorkspace() {
        if (!currentProject) {
            alert("Please create a project first before adding files.");
            return;
        }

        const fileName = prompt("Enter file name (e.g., utils.cpp, hello.h):");
        if (!fileName) return;

        const lang = detectLanguage(fileName);
        let internalPath = fileName;
        let content = `// New ${fileName}\n`;

        if (lang === 'cpp') {
            internalPath = `src/${fileName}`;
            content = `#include <iostream>\n\n// Code implementation\n`;
        } else if (lang === 'c') {
            if (fileName.endsWith('.h') || fileName.endsWith('.hpp')) {
                internalPath = `include/${fileName}`;
                content = `#ifndef ${fileName.replace('.', '_').toUpperCase()}\n#define ${fileName.replace('.', '_').toUpperCase()}\n\n#endif\n`;
            } else {
                internalPath = `src/${fileName}`;
                content = `#include <stdio.h>\n`;
            }
        }

        if (files[internalPath]) {
            alert("File already exists in this directory position!");
            return;
        }

        fetch('http://localhost:5000/api/file/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectName: currentProject,
                filePath: internalPath,
                content: content
            })
        }).then(res => res.json())
          .then(data => {
              if (data.success) {
                  files[internalPath] = {
                      model: monaco.editor.createModel(content, lang)
                  };
                  switchToFile(internalPath);
              } else {
                  alert("Backend error creating physical file.");
              }
          }).catch(err => {
              console.error(err);
              alert("Could not connect to backend file system.");
          });
    }

    async function deleteFileFromWorkspace(internalPath) {
        if (!currentProject || !internalPath) return;

        const isProjectConfig = internalPath.endsWith('.pjt');
        const message = isProjectConfig 
            ? `⚠️ WARNING! Deleting the project configuration file will PERMANENTLY DELETE the entire project folder "${currentProject}" and all its files from disk. Proceed?`
            : `Are you sure you want to permanently delete ${internalPath} from disk?`;

        const confirmDelete = confirm(message);
        if (!confirmDelete) return;

        try {
            const response = await fetch('http://localhost:5000/api/file/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectName: currentProject, filePath: internalPath })
            });

            const data = await response.json();

            if (data.success) {
                if (data.projectDeleted) {
                    Object.keys(files).forEach(path => {
                        if (files[path] && files[path].model) {
                            files[path].model.dispose();
                        }
                    });
                    
                    for (const key in files) {
                        if (files.hasOwnProperty(key)) {
                            delete files[key];
                        }
                    }
                    
                    activeFile = null;
                    currentProject = null;
                    
                    editor.setModel(blankModel);
                    editor.updateOptions({ readOnly: true });
                    tabsContainer.innerHTML = '';
                    fileTreeContainer.innerHTML = '<div style="padding:10px; color:#858585; font-style:italic;">No project open</div>';
                    
                    alert("The project has been completely deleted.");
                    
                    if (welcomeModal) {
                        welcomeModal.style.display = 'flex'; 
                        setTimeout(() => {
                            const inputEl = document.getElementById('modal-project-input');
                            if (inputEl) inputEl.focus();
                        }, 50);
                    }
                }
            } else {
                alert(`Error: ${data.error}`);
            }
        } catch (err) {
            console.error(err);
            alert("Could not connect to backend filesystem. Please make sure server.js is running on port 5000.");
        }
    }

    document.getElementById('explorer-add-btn').addEventListener('click', createNewFileInWorkspace);
    // Nasłuchiwanie przycisku "+" w panelu Watches
    const addWatchBtn = document.getElementById('add-watch-btn');
    if (addWatchBtn) {
        addWatchBtn.addEventListener('click', promptAddWatchVariable);
    }
    const actionBtn = document.getElementById('action-btn');
    const chatInput = document.getElementById('chat-input');
    const chatOutput = document.getElementById('chat-output');

    async function sendAiRequest() {
        const prompt = chatInput.value.trim();
        if (!prompt) return;

        chatOutput.innerHTML += `\n<div style="color: #007acc; margin-top: 10px;"><b>You:</b> ${prompt}</div>`;
        chatInput.value = '';

        const activeContent = activeFile && files[activeFile] && files[activeFile].model 
            ? files[activeFile].model.getValue() 
            : "";

        try {
            const response = await fetch('http://localhost:5000/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: prompt,
                    projectName: currentProject,
                    activeFile: activeFile,
                    code: activeContent
                })
            });

            const resData = await response.json();
            
            if (resData.success && resData.data) {
                const ai = resData.data;

                chatOutput.innerHTML += `\n<div style="color: #aaaaaa; margin-top: 10px;"><b>Gemini:</b> ${ai.explanation}</div>`;

                if (ai.modifications && Array.isArray(ai.modifications)) {
                    for (const mod of ai.modifications) {
                        const targetPath = mod.targetPath;
                        const extension = targetPath.split('.').pop();
                        let lang = 'plaintext';
                        if (extension === 'cpp' || extension === 'h') lang = 'cpp';
                        if (extension === 'json' || extension === 'pjt') lang = 'json';

                        if (mod.action === 'edit') {
                            if (files[targetPath]) {
                                if (files[targetPath].model) {
                                    files[targetPath].model.setValue(mod.code);
                                } else {
                                    files[targetPath] = mod.code;
                                }
                                chatOutput.innerHTML += `<div style="color: #73c991; font-size: 11px; margin-top: 2px;">⚡ Updated file model: ${targetPath}</div>`;
                            } else {
                                files[targetPath] = { model: monaco.editor.createModel(mod.code, lang) };
                                chatOutput.innerHTML += `<div style="color: #ffaa00; font-size: 11px; margin-top: 2px;">⚠️ Indexed missing target file for edit: ${targetPath}</div>`;
                            }
                        }
                        else if (mod.action === 'create') {
                            files[targetPath] = { model: monaco.editor.createModel(mod.code, lang) };
                            chatOutput.innerHTML += `<div style="color: #73c991; font-size: 11px; margin-top: 2px;">✨ Created module target: ${targetPath}</div>`;
                        }

                        await fetch('http://localhost:5000/api/file/save', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectName: currentProject, filePath: targetPath, content: mod.code })
                        });
                    }

                    syncWorkspaceUI();
                }

            } else {
                chatOutput.innerHTML += `\n<div style="color: #f48771; margin-top: 10px;"><b>Gemini:</b> Failed parsing structured output content.</div>`;
            }
        } catch (err) {
            console.error(err);
            chatOutput.innerHTML += `\n<div style="color: #ff3333; margin-top: 10px;"><b>System Error:</b> Could not contact Gemini Copilot backend.</div>`;
        }

        chatOutput.scrollTop = chatOutput.scrollHeight;
    }

    actionBtn.addEventListener('click', sendAiRequest);

    chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault(); 
            sendAiRequest();    
        }
    });

    // --- INTERAKTYWNY TERMINAL + AUTOMATYCZNY PARSER GDB ---
    function initTerminalSocket(projectName) {
        if (terminalSocket) {
            terminalSocket.close();
        }

        terminalSocket = new WebSocket('ws://localhost:5001');

        terminalSocket.onopen = () => {
            terminalSocket.send(JSON.stringify({ type: 'init', projectName: projectName }));
        };

       terminalSocket.onmessage = function(event) {
            const msg = JSON.parse(event.data);
            if (msg.type === 'output') {
                const cleanData = msg.data.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

                // --- 1. KROCZĄCY LOG DLA OCHRONY PRZED ROZBIJANIEM CHUNKÓW ---
                window.gdbOutputLog = (window.gdbOutputLog || "") + cleanData;
                if (window.gdbOutputLog.length > 5000) {
                    window.gdbOutputLog = window.gdbOutputLog.slice(-2000); // Trzymamy tylko końcówkę logu
                }

                // --- 2. CAŁKOWICIE IZOLOWANE PRZECHWYTYWANIE BACKTRACE (CALL STACK) ---
                if (window.gdbSilentlyFetchingBt) {
                    window.gdbBtBuffer = (window.gdbBtBuffer || "") + cleanData;
                    
                    // Bezpieczne sprawdzanie skumulowanego bufora, a nie pojedynczego chunku
                    if (window.gdbBtBuffer.includes('(gdb)')) {
                        window.gdbSilentlyFetchingBt = false;
                        parseAndRenderCallStack(window.gdbBtBuffer);
                        window.gdbBtBuffer = "";
                    }
                    return; // Blokujemy wyciek bebechów komendy bt do terminala
                }
		// --- NOWOŚĆ: CAŁKOWICIE IZOLOWANE PRZECHWYTYWANIE WARTOŚCI WATCHES (GDB PRINT) ---
                if (window.gdbSilentlyFetchingWatch && currentQueryingVariable) {
                    window.gdbWatchBuffer = (window.gdbWatchBuffer || "") + cleanData;
                    
                    if (window.gdbWatchBuffer.includes('(gdb)')) {
                        window.gdbSilentlyFetchingWatch = false;
                        
                        // Wyciągamy wartość z formatu GDB, np. "$1 = 42\n(gdb)" lub "$2 = 0x7fffffffe000\n(gdb)"
                        // Szukamy znaku '=' w buforze
                        const eqIndex = window.gdbWatchBuffer.indexOf('=');
                        if (eqIndex !== -1) {
                            let rawValue = window.gdbWatchBuffer.substring(eqIndex + 1);
                            // Obcinamy prompt '(gdb)' oraz białe znaki z końca i początku
                            rawValue = rawValue.replace('(gdb)', '').trim();
                            
                            // Zapisujemy oczyszczoną wartość do mapy
                            if (!window.gdbWatchesValuesMap) window.gdbWatchesValuesMap = {};
                            window.gdbWatchesValuesMap[currentQueryingVariable] = rawValue;
                        } else {
                            if (!window.gdbWatchesValuesMap) window.gdbWatchesValuesMap = {};
                            window.gdbWatchesValuesMap[currentQueryingVariable] = "error/not found";
                        }

                        window.gdbWatchBuffer = "";
                        // Przechodzimy do odpytania kolejnej zmiennej z kolejki
                        queryNextWatchVariable();
                    }
                    return; // Blokujemy wypisanie śmieci printu GDB w głównym oknie konsoli
                }    

                // Funkcje layoutu
                const aiSidebar = document.getElementById('ai-sidebar');
                const debugSidebar = document.getElementById('debug-sidebar');

                const switchToDebugLayout = () => {
                    if (aiSidebar && debugSidebar) {
                        aiSidebar.style.setProperty('display', 'none', 'important');
                        debugSidebar.style.setProperty('display', 'flex', 'important');
                    }
                };

                const switchToAiLayout = () => {
                    if (aiSidebar && debugSidebar) {
                        debugSidebar.style.setProperty('display', 'none', 'important');
                        aiSidebar.style.removeProperty('display');
                    }
                };

                if (cleanData.includes('(gdb)') || cleanData.includes('Reading symbols from')) {
                    switchToDebugLayout();
                }

                // --- 3. PARSER KROKÓW GDB (USTAWIANIE STRZAŁKI W EDYTORZE) ---
                if (cleanData.includes('at ') && cleanData.includes(':')) {
                    const match = cleanData.match(/at\s+([^\s:]+):(\d+)/);
                    if (match) {
                        switchToDebugLayout();
                        const parsedPath = match[1].trim();
                        const lineNum = parseInt(match[2], 10);

                        let targetPath = parsedPath;
                        if (!files[targetPath]) {
                            const keys = Object.keys(files);
                            const found = keys.find(k => k.endsWith(parsedPath) || parsedPath.endsWith(k));
                            if (found) targetPath = found;
                        }

                        window.currentDebugLineNumber = lineNum;
                        debugActiveFile = targetPath;

                        if (files[targetPath]) {
                            if (activeFile !== targetPath) {
                                switchToFile(targetPath);
                            }
                            if (window.showDebugLocation) {
                                window.showDebugLocation(targetPath, lineNum);
                            }
                        }
                        window.gdbStepJustHappened = true; // Flaga: Potwierdzono krok w kodzie
                    }
                } 
                else if (debugActiveFile) { 
                    const stepMatch = cleanData.match(/(?:^|\r|\n)(\d+)(?:\t|\s{2,})/);
                    if (stepMatch) {
                        const lineNum = parseInt(stepMatch[1], 10);
                        window.currentDebugLineNumber = lineNum;
                        
                        if (window.showDebugLocation) {
                            window.showDebugLocation(debugActiveFile, lineNum);
                        }
                        window.gdbStepJustHappened = true; // Flaga: Potwierdzono krok w kodzie
                    }
                }

                // Gwarantowane i nienaruszone renderowanie outputu (w tym Twoich printf-ów z programu!)
                termOutput.innerHTML += msg.data;
                termOutput.scrollTop = termOutput.scrollHeight;

                // --- 4. BEZPIECZNE WYWOŁANIE UKRYTEGO 'BT' (DOPIERO GDY TERMINAL STOI NA PROMPTIE) ---
                if (window.gdbStepJustHappened && window.gdbOutputLog.trim().endsWith('(gdb)')) {
                    window.gdbStepJustHappened = false;
                    window.gdbSilentlyFetchingBt = true;
                    window.gdbBtBuffer = "";

                    if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
                        terminalSocket.send(JSON.stringify({ type: 'input', data: 'bt' }));
                    }
                }

                // --- 5. AUTOMATYCZNE WYJŚCIE Z SESJI ---
                if (cleanData.includes('[Inferior 1') && (cleanData.includes('exited normally]') || cleanData.includes('exited with code'))) {
                    if (window.clearDebugLocation) window.clearDebugLocation();
                    debugActiveFile = null;
                    window.currentDebugLineNumber = null;
                    window.gdbStepJustHappened = false;

                    const callstackList = document.getElementById('callstack-list');
                    if (callstackList) {
                        callstackList.innerHTML = '<span style="color: #6a9955; font-style: italic; padding: 10px; display: block;">No active frames.</span>';
                    }
		    renderWatchesList({});
		    window.gdbLastWatchesValuesMap = {};
                    if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
                        setTimeout(() => {
                            terminalSocket.send(JSON.stringify({ type: 'input', data: 'exit' }));
                            switchToAiLayout();
                        }, 150);
                    }

                }
            }
        };
    }

    // JEDYNY SŁUCHACZ DLA INPUTU TERMINALA
    if (termInput) {
        termInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                const cmd = termInput.value.trim();
                if (!cmd) return;

                if (!currentProject) {
                    termOutput.innerHTML += `\n<span style="color: #ffaa00;">⚠️ Open a project workspace first.</span>`;
                    termInput.value = '';
                    return;
                }

                if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
	                window.gdbStepJustHappened = false;
                    window.gdbSilentlyFetchingBt = false;
                    terminalSocket.send(JSON.stringify({ type: 'input', data: cmd }));
                    termInput.value = '';
                } else {
                    termOutput.innerHTML += `\n<span style="color: #ffaa00;">⚠️ Terminal connection lost. Reconnecting...</span>`;
                    initTerminalSocket(currentProject);
                }
            }
        });
    }

// --- INTELIGENTNY PARSER STOSU WYWOŁAŃ (CALL STACK) ---
function parseAndRenderCallStack(rawBtText) {
    const callstackList = document.getElementById('callstack-list');
    if (!callstackList) return;

    callstackList.innerHTML = ''; // Czyszczenie starej listy

    const lines = rawBtText.split(/\r?\n/);
    let framesFound = false;

    let activeFrameTarget = null;
    let activeFrameLine = null;

    lines.forEach(line => {
        const frameMatch = line.match(/^#(\d+)\s+(?:0x[0-9a-fA-F]+\s+in\s+)?([^\s(]+)\s*\(.*?\)\s+at\s+([^\s:]+):(\d+)/);
        
        if (frameMatch) {
            framesFound = true;
            const frameNum = frameMatch[1];
            const funcName = frameMatch[2];
            const rawPath = frameMatch[3].trim();
            const lineNum = parseInt(frameMatch[4], 10);

            let targetPath = rawPath;
            if (!files[targetPath]) {
                const keys = Object.keys(files);
                const found = keys.find(k => k.endsWith(rawPath) || rawPath.endsWith(k));
                if (found) targetPath = found;
            }

            const isCurrentExecutionPoint = (frameNum === "0" || parseInt(frameNum, 10) === 0);
            if (isCurrentExecutionPoint) {
                activeFrameTarget = targetPath;
                activeFrameLine = lineNum;
            }

            const frameEl = document.createElement('div');
            frameEl.className = 'callstack-item';
            
            // Bindowanie ukrytych właściwości danych dla przełączania strzałkami:
            frameEl.__targetPath = targetPath;
            frameEl.__lineNum = lineNum;
            
            // Domyślnie zaznaczamy ramkę #0 jako aktywną
            if (isCurrentExecutionPoint) {
                frameEl.classList.add('active-callstack-item');
                frameEl.style.backgroundColor = '#37373d'; 
            } else {
                frameEl.style.backgroundColor = 'transparent';
            }

            frameEl.style.padding = '6px 10px';
            frameEl.style.cursor = 'pointer';
            frameEl.style.borderBottom = '1px solid #2d2d2d';
            frameEl.style.fontSize = '12px';
            frameEl.style.display = 'flex';
            frameEl.style.flexDirection = 'column';
            frameEl.style.transition = 'background 0.2s';

            // Efekt hover (szanuje stan aktywności elementu)
            frameEl.onmouseenter = () => frameEl.style.backgroundColor = '#2a2d2e';
            frameEl.onmouseleave = () => {
                frameEl.style.backgroundColor = frameEl.classList.contains('active-callstack-item') ? '#37373d' : 'transparent';
            };

            frameEl.innerHTML = `
                <div style="font-weight: bold; color: ${isCurrentExecutionPoint ? '#ffcc00' : '#569cd6'};">#${frameNum} ${funcName}()</div>
                <div style="color: #858585; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${rawPath}:${lineNum}
                </div>
            `;

            frameEl.addEventListener('click', () => {
                const allItems = callstackList.querySelectorAll('.callstack-item');
                allItems.forEach(item => {
                    item.classList.remove('active-callstack-item');
                    item.style.backgroundColor = 'transparent';
                });
                frameEl.classList.add('active-callstack-item');
                frameEl.style.backgroundColor = '#37373d';

                if (files[targetPath]) {
                    if (activeFile !== targetPath) {
                        switchToFile(targetPath);
                    }
                    
                    setTimeout(() => {
                        if (window.showDebugLocation) {
                            window.showDebugLocation(targetPath, lineNum);
                        } else {
                            editor.setPosition({ lineNumber: lineNum, column: 1 });
                            editor.revealLineInCenter(lineNum);
                        }
                    }, 50);
                }
            });

            callstackList.appendChild(frameEl);
        }
    });

    if (activeFrameTarget && files[activeFrameTarget]) {
        if (activeFile !== activeFrameTarget) {
            switchToFile(activeFrameTarget);
        }
        
        setTimeout(() => {
            if (window.showDebugLocation) {
                window.showDebugLocation(activeFrameTarget, activeFrameLine);
            } else {
                editor.setPosition({ lineNumber: activeFrameLine, column: 1 });
                editor.revealLineInCenter(activeFrameLine);
            }
        }, 50);
    }

    if (!framesFound) {
        callstackList.innerHTML = '<span style="color: #858585; font-style: italic; padding: 10px; display: block;">No debug frames available.</span>';
    }

    updateWatchesValues();	
}
// --- RENDEROWANIE LISTY WATCHES W INTERFEJSIE Z PODŚWIETLANIEM ZMIAN ---
function renderWatchesList(valuesMap = {}) {
    const container = document.getElementById('watches-list');
    if (!container) return;
    container.innerHTML = '';

    if (watchedVariables.length === 0) {
        container.innerHTML = `<span style="color: #6a9955; font-style: italic;">No active watches. Click + to add.</span>`;
        activeWatchIndex = null;
        return;
    }

    watchedVariables.forEach((variable, index) => {
        const row = document.createElement('div');
        row.className = 'watch-item';
        // Przypisujemy atrybuty umożliwiające focus i identyfikację
        row.tabIndex = 0; 
        row.dataset.index = index;
        
        // Style bazowe wiersza
        row.style.padding = '4px 8px';
        row.style.cursor = 'pointer';
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.borderRadius = '3px';
        row.style.outline = 'none';

        // Jeśli ten element był wcześniej zaznaczony, przywracamy podświetlenie
        if (index === activeWatchIndex) {
            row.style.backgroundColor = '#37373d';
        }

        const val = valuesMap[variable] !== undefined ? valuesMap[variable] : "unknown";
        
        row.innerHTML = `
            <span style="color: #9cdcfe;">${variable}</span>
            <span style="color: #ce9178;">${val}</span>
        `;

        // Zdarzenie kliknięcia myszką
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            selectWatchItem(index);
        });

        container.appendChild(row);
    });
}

// Funkcja pomocnicza do zaznaczania elementu
function selectWatchItem(index) {
    if (index < 0 || index >= watchedVariables.length) return;
    
    activeWatchIndex = index;
    const items = document.querySelectorAll('#watches-list .watch-item');
    
    items.forEach((item, i) => {
        if (i === index) {
            item.style.backgroundColor = '#37373d'; // Kolor podświetlenia (taki jak w VS Code)
            item.focus();
        } else {
            item.style.backgroundColor = 'transparent';
        }
    });
}

// --- FUNKCJA URUCHAMIAJĄCA SERIĘ ZAPYTAŃ 'print' DO GDB ---
function updateWatchesValues() {
    if (watchedVariables.length === 0 || !terminalSocket || terminalSocket.readyState !== WebSocket.OPEN) {
        renderWatchesList({});
        return;
    }

    // ZAPAMIĘTUJEMY POPRZEDNIE WARTOŚCI PRZED POBRANIEM NOWYCH
    // Kopiujemy obecną mapę wartości jako punkt odniesienia do porównań
    window.gdbLastWatchesValuesMap = Object.assign({}, window.gdbWatchesValuesMap || {});

    // Klonujemy listę zmiennych do kolejki odpytywania
    gdbVariablesToQuery = [...watchedVariables];
    window.gdbWatchesValuesMap = {}; // Kontener na świeże wartości
    
    // Rozpoczynamy odpytywanie pierwszej zmiennej z kolejki
    queryNextWatchVariable();
}
const watchesPanel = document.getElementById('watches-panel');

if (watchesPanel) {
    watchesPanel.addEventListener('keydown', function(e) {
        if (watchedVariables.length === 0) return;

        // 1. Strzałka w dół
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (activeWatchIndex === null) {
                selectWatchItem(0);
            } else if (activeWatchIndex < watchedVariables.length - 1) {
                selectWatchItem(activeWatchIndex + 1);
            }
        }
        
        // 2. Strzałka w górę
        else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (activeWatchIndex === null) {
                selectWatchItem(watchedVariables.length - 1);
            } else if (activeWatchIndex > 0) {
                selectWatchItem(activeWatchIndex - 1);
            }
        }
        
        // 3. Klawisz DELETE - Usuwanie zmiennej z Watches
        else if (e.key === 'Delete') {
            e.preventDefault();
            if (activeWatchIndex !== null) {
                const removedVar = watchedVariables[activeWatchIndex];
                console.log(`🗑️ Usuwam z watches: ${removedVar}`);
                
                // Usuwamy z tablicy
                watchedVariables.splice(activeWatchIndex, 1);
                
                // Dostosowujemy indeks po usunięciu elementu
                if (watchedVariables.length === 0) {
                    activeWatchIndex = null;
                } else if (activeWatchIndex >= watchedVariables.length) {
                    activeWatchIndex = watchedVariables.length - 1;
                }

                // Odświeżamy widok
                if (typeof updateWatchesValues === 'function' && debugActiveFile) {
                    updateWatchesValues();
                } else {
                    renderWatchesList({});
                }

                // Po odświeżeniu DOM, ustawiamy focus na nowy aktywny element (jeśli istnieje)
                if (activeWatchIndex !== null) {
                    setTimeout(() => selectWatchItem(activeWatchIndex), 10);
                }
            }
        }
    });
}
// Pobiera kolejną zmienną z kolejki i wysyła komendę do terminala
function queryNextWatchVariable() {
    if (gdbVariablesToQuery.length === 0) {
        // Wszystkie zmienne zostały odpytane -> renderujemy wynik końcowy
        currentQueryingVariable = null;
        renderWatchesList(window.gdbWatchesValuesMap || {});
        return;
    }

    currentQueryingVariable = gdbVariablesToQuery.shift();
    window.gdbSilentlyFetchingWatch = true; // Flaga blokady wycieku tekstu dla terminala
    window.gdbWatchBuffer = "";

    terminalSocket.send(JSON.stringify({ type: 'input', data: `print ${currentQueryingVariable}` }));
}

// --- FUNKCJA OBSŁUGI DODAWANIA NOWEJ ZMIENNEJ ---
function promptAddWatchVariable() {
    const varName = prompt("Enter variable name or expression to watch (e.g. counter, myArray[0], ptr->val):");
    if (!varName) return;
    
    const trimmed = varName.trim();
    if (trimmed && !watchedVariables.includes(trimmed)) {
        watchedVariables.push(trimmed);
        if (debugActiveFile) {
            updateWatchesValues(); // Jeśli trwa debugowanie, od razu pobierz wartość z GDB
        } else {
            renderWatchesList({}); // Jeśli sesja nie trwa, tylko dodaj na listę jako "unknown"
        }
    }
}

// Globalna funkcja umożliwiająca klikanie w ramki stosu i automatyczne przenoszenie edytora do wybranej linii
window.jumpToFrame = function(filePath, lineNum) {
    console.log("Jumping to frame:", filePath, "at line:", lineNum);
    
    let targetPath = filePath;
    
    if (!files[targetPath]) {
        const keys = Object.keys(files);
        const found = keys.find(k => k.endsWith(filePath) || filePath.endsWith(k));
        if (found) {
            targetPath = found;
        }
    }
    
    if (files[targetPath]) {
        switchToFile(targetPath);
        
        setTimeout(() => {
            if (window.showDebugLocation) {
                window.showDebugLocation(targetPath, parseInt(lineNum));
            } else {
                editor.setPosition({ lineNumber: parseInt(lineNum), column: 1 });
                editor.revealLineInCenter(parseInt(lineNum));
            }
        }, 50);
    } else {
        console.error("Could not find file in workspace for GDB frame:", filePath);
    }
};

    setTimeout(() => {
        const modalInput = document.getElementById('modal-project-input');
        if (modalInput) modalInput.focus();
    }, 100); 
});
