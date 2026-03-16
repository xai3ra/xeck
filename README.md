# Xeck - Private Contract Manager

Xeck is a privacy-focused contract management application that synchronizes with Google Drive or stays 100% local.

## 🚀 Initialization & Distribution

To prepare the project for a clean distribution (e.g., sharing on GitHub or packaging for the first time):

1.  **Cleanup**: Run `node init_project.js`. This will delete all local contract files, specific database entries, and logs.
2.  **Environment**: Ensure you have [Node.js](https://nodejs.org/) installed.
3.  **Install dependencies**:
    ```bash
    npm install
    ```
4.  **Package to .exe**:
    ```bash
    npm run dist
    ```
    The packaged executable will be generated in the `release/` folder as a **Portable Windows Executive**.

## ☁️ GitHub Maintenance & Updates

### Pushing to GitHub
- The `.gitignore` is configured to **exclude** your `contracts.db` and the `Contracts/` folder. This ensures your private data is never uploaded.
- To push updates:
    ```bash
    git add .
    git commit -m "Update description"
    git push origin main
    ```

### Pulling Updates
- When you want to update the app from GitHub:
    ```bash
    git pull
    npm install
    ```
- Your local `contracts.db` and `Contracts/` folder will **remain untouched** because they are ignored by Git.

## 🛠 Developer Settings
- Toggle the "Developer Settings" button in the App UI to configure your own Google OAuth Client IDs if you want to use the Cloud Sync feature on a personal project.
