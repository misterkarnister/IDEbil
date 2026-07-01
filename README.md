# IDEbil
Simple C/C++ IDE vibe-coded in Node.js

# Installation
1. Install [Node.js](https://nodejs.org/en/download)
2. Download the repositorium
```
git clone https://github.com/misterkarnister/IDEbil
```
3. Run the install script
```
node install.js
```
Follow instructions in script if needed

# Configuring
Create .env file
```
OPENROUTER_API_KEY=YOUR_API_KEY
PORT=5000
```
If you want to use AI(which is for the most part broken so you would rather not), you have to get API key from [openrouter.ai](https://openrouter.ai/)
Change the port if you want

# Running
Run
```
npm start
```
# How to use
Everything you do from folder in which you have the IDE. Move it to a safe place and treat as one of your important folders

## Startup
At first the prompt will appear. You have to provide name for your project. Projects are saved in projects/*project_name* folder.

If the folder already exists, the project will be opened, otherwise a new one will be created

## Main view
There are few panels in the main view:
### Workspace
This is the place in which you can see all your files and change between them
1. *project_name*.pjt is your project file, you can change the values that are self-explanatory
2. Under src folder,  go your source files (.cpp or .c)
3. Under include folder, go your header files (.hpp or .h)

To create and add to your project a new file, click + next to Workspace text.
A prompt will appear to name the file, provide it with file extension
To delete a file, click bin icon next to it

### Editor
This is the simple editor for your files

### Command prompt
Here you can type in any commands you want(g++ to compile for example) and also is output for most commands

### AI sidebar
If you provided openrouter API key in your .env file, you should be able to use AI.
You can ask AI for help. You can ask it to explain code or even modify it(however it usually doesnt work the way you intend to).
To mention a file use @, f.e @src/main.cpp

## Debugging session
If you installed gdb, you can start debugging session by clicking F8.

You can set breakpoints by clicking next to line number.
You can send any commands to gdb in command prompt panel

Two different pannels will cover AI sidebar:
### Watches
Here you can view how variables change over program execution
To add a new variable to watch click + next to text Watches
To delete a variable, click bin icon next to it
### Call stack
Here you can watch function calls as program executes
To view point from which the function was called, click on the function

# Building and executing program
To build and run program, click F9

# Keyboard shortcuts

## Focus
ALT+1 - focus workspace
ALT+2 - focus editor
ALT+3 - focus command prompt
ALT+4 - focus AI sidebar/watches
ALT+5 - focus call stack

## Moving
ArrowUp/ArrowDown - move between:
1. files when workspace focused
2. variables when watches focused
3. function calls when call stack focused
## Deletion
Delete - delete:
1. files when workspace focused
2. variables when watches focused

**Deleting .pjt file deletes whole project!**

## Creation
ALT+n - create new file
ALT+w - create new variable to watch in watches

## Saving
CTRL+S - save file

## Debugging session:
F8 - start debugging session
F7 - stop debugging session
F2 - toggle breakpoint on cursor line
F3 - step (gdb command)
F4 - next (gdb command)
F6 - continue (gdb command)

## Other:
F9 - compile and run with g++
ALT+. - go to definition
ALT+SHIFT+. - go to declaration





