const fs = require('fs');
const path = require('path');

const filesToDelete = [
    'contracts.db',
    'logs.txt',
    'server.log',
    'server_err.log',
    'contracts_dump.json'
];

const dirsToDelete = [
    'Contracts',
    'uploads',
    'release',
    'dist'
];

console.log('--- Xeck Project Initialization ---');

filesToDelete.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted file: ${file}`);
    }
});

dirsToDelete.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`Deleted directory: ${dir}`);
    }
});

console.log('\nProject initialized. legacy data removed.');
console.log('Run "npm install" then "npm run dist" to package the app.');
