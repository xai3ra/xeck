# Xeck — Contract & Document Management Assistant

 [English](#english) | [Español](#español) | [简体中文](#简体中文)

---
<a name="english"></a>
## 🇺🇸 English

**Xeck** is a privacy-focused contract management desktop application. It supports local storage or Google Drive synchronization, with built-in AI for automatic contract analysis.

### 📥 Download & Installation
1. Go to the [GitHub Releases](https://github.com/xai3ra/xeck/releases) page.
2. Download the latest `Xeck.exe` or `Xeck Portable.exe`.
3. Run the file. If Windows SmartScreen appears, click "**More info**" → "**Run anyway**".

### 🗂️ Storage Modes
On first launch, you can choose how to store your data:
- **🖥️ Local Storage**: No login required. Data stays on your computer. 100% private.
- **☁️ Google Drive Sync**: Log in with your Google account to sync data via Google Drive. Supports multiple devices.

#### ☁️ How to get Google OAuth Credentials (Client ID & Secret)
To use Google Drive Sync, you need to obtain your own keys:
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. **Create a Project**: Click the project selector at the top and create a new project (e.g., "My Xeck").
3. **Enable API**: Go to "APIs & Services > Library", search for and enable **Google Drive API**.
4. **OAuth Consent Screen**:
   - Go to "OAuth consent screen" and select "External".
   - Fill in the app name and support email.
   - In "Scopes", add `.../auth/drive.file`.
5. **Create Credentials**:
   - Go to the "Credentials" page.
   - Click "Create Credentials" > "**OAuth client ID**" and select "**Desktop App**".
6. **Copy Keys**: Copy the **Client ID** and **Client Secret** and paste them into Xeck's **Settings > Account / Storage**.

### ➕ Adding Contracts & Documents
- **Adding Contracts**: Click "Add New Contract +", fill in the title, cost, category, and dates. You can upload attachments.
- **Adding Documents**: Select "**Documentation**" as the category. The cost will automatically set to **0**. Documents are displayed in a separate section at the bottom.

### 🏷️ Category Guide
- **Utilities**: Water, gas, electricity.
- **Insurance**: Car, home, life, or health policies.
- **Mobile/Internet**: Phone plans and broadband services.
- **Subscription**: Streaming services, gym memberships, software.
- **Documentation**: Passports, ID cards, licenses (Cost = 0).

### 🤖 AI Smart Analysis
After uploading a document, click "**✨ Analyze with AI**". The AI will automatically extract the title, actual recurring cost (filtering out financing/discounts), category, and expiry dates.
> *Note: Requires an AI API Key in Settings.*

### ⚙️ Settings & Data
- **AI Assistant**: Configure OpenAI/Gemini/Claude/NVIDIA keys.
- **Data Management**: Export or Import ZIP backups with one click.
- **Language**: Switch between CN, ENG, and ESP instantly.

---

<a name="español"></a>
## 🇪🇸 Español

**Xeck** es una aplicación de escritorio para la gestión privada de contratos. Soporta almacenamiento local o sincronización con Google Drive, e incluye IA integrada para el análisis automático de documentos.

### 📥 Descarga e Instalación
1. Ve a la página de [GitHub Releases](https://github.com/xai3ra/xeck/releases).
2. Descarga la última versión de `Xeck.exe` o `Xeck Portable.exe`.
3. Ejecuta el archivo. Si aparece Windows SmartScreen, haz clic en "**Más información**" → "**Ejecutar de todas formas**".

### 🗂️ Modos de Almacenamiento
Al iniciar por primera vez, podrás elegir el método de almacenamiento:
- **🖥️ Almacenamiento Local**: Sin inicio de sesión. Datos 100% privados en tu ordenador.
- **☁️ Sincronización Google Drive**: Inicia sesión con tu cuenta de Google para sincronizar entre múltiples dispositivos.

#### ☁️ Cómo obtener credenciales de Google OAuth (ID y Secreto)
Para usar la sincronización con Google Drive, necesitas tus propias llaves:
1. Ve a [Google Cloud Console](https://console.cloud.google.com/).
2. **Crear un Proyecto**: Haz clic en el selector de proyectos arriba y crea uno nuevo (ej. "Mi Xeck").
3. **Habilitar API**: Ve a "API y servicios > Biblioteca", busca y habilita **Google Drive API**.
4. **Pantalla de consentimiento**:
   - Ve a "Pantalla de consentimiento de OAuth" y selecciona "Externos".
   - Rellena el nombre de la app y el correo de soporte.
   - En "Permisos (Scopes)", añade `.../auth/drive.file`.
5. **Crear Credenciales**:
   - Ve a la página de "Credenciales".
   - Haz clic en "Crear credenciales" > "**ID de cliente de OAuth**" y selecciona "**Aplicación de escritorio**".
6. **Copiar llaves**: Copia el **ID de cliente** y el **Secreto de cliente** y pégalos en Xeck (Ajustes > Cuenta).

### ➕ Añadir Contratos y Documentos
- **Añadir Contrato**: Haz clic en "Añadir nuevo +", completa el título, coste, categoría y fechas. Puedes subir adjuntos.
- **Añadir Documentos**: Elige la categoría "**Documentación**". El coste se pondrá automáticamente en **0**. Se mostrarán en una sección separada abajo del resumen.

### 🏷️ Guía de Categorías
- **Servicios (Utilities)**: Luz, agua, gas.
- **Seguros (Insurance)**: Coche, hogar, vida o salud.
- **Móvil/Internet**: Tarifas móviles y fibra.
- **Suscripción (Subscription)**: Streaming, gimnasio, software.
- **Documentación**: Pasaportes, DNI, carnets (Coste = 0).

### 🤖 Análisis Inteligente con IA
Tras subir un archivo, pulsa en "**✨ Analizar con IA**". La IA extraerá automáticamente el título, el coste recurrente real (filtrando financiaciones o descuentos), la categoría y las fechas de vencimiento.
> *Nota: Requiere configurar una API Key en Ajustes.*

### ⚙️ Ajustes y Datos
- **Asistente IA**: Configura claves de OpenAI/Gemini/Claude/NVIDIA.
- **Gestión de Datos**: Exporta o importa copias de seguridad en ZIP con un solo clic.
- **Idioma**: Cambia entre Chino, Inglés y Español al instante.

---

## 💾 Data Backup
- We recommend using **Settings → Export Backup** regularly.
- In Google Drive mode, data is synced automatically.
- For Local mode, data is stored in the user profile directory.

---

<a name="简体中文"></a>
## 🇨🇳 简体中文

**Xeck** 是一款私人合同管理桌面应用。支持本地存储或 Google Drive 云端同步，内置 AI 自动分析合同文件。

### 📥 下载安装
1. 前往 [GitHub Releases](https://github.com/xai3ra/xeck/releases) 页面
2. 下载最新版本的 `Xeck.exe` 或 `Xeck Portable.exe`
3. 双击运行，如出现 Windows SmartScreen 提示，点击"**更多信息**" → "**仍要运行**"

### 🗂️ 存储模式选择
首次启动时，应用会让你选择存储方式：
- **🖥️ 本地存储**：无需登录，数据完全保存在本机，100% 私密。
- **☁️ Google Drive 同步**：通过 Google 账号登录，数据同步到 Google Drive，支持多设备。

#### ☁️ 如何获取 Google OAuth 凭据 (Client ID & Secret)
如果您想使用 Google Drive 同步功能，需要获取您自己的密钥：
1. 访问 [Google Cloud Console](https://console.cloud.google.com/)。
2. **创建项目**：点击项目选择器，创建一个新项目（如 "My Xeck"）。
3. **启用 API**：进入 "API 和服务 > 库"，搜索并启用 **Google Drive API**。
4. **配置同意屏幕**：进入 "OAuth 同意屏幕"，选择 "外部 (External)"，填写信息并在范围中添加 `.../auth/drive.file`。
5. **创建凭据**：进入 "凭据" 页面，点击 "创建凭据" > "**OAuth 客户端 ID**"，类型选择 "**桌面应用**"。
6. **复制密钥**：将 **客户端 ID** 和 **客户端密钥** 粘贴到 Xeck 的 **设置 > 账号与存储** 中即可。

### ➕ 添加合同与证件
- **添加合同**：点击"添加新合同 +"，填写标题、月费、分类、日期等，可上传附件。
- **添加证件**：分类选择"**证件 (Documentation)**"，月费会自动设为 **0**。证件会显示在主界面底部的独立区域。

### 🏷️ 分类说明
- **水电煤 (Utilities)**：电费、水费、天然气等。
- **保险 (Insurance)**：保单、各类保险。
- **通信 (Mobile/Internet)**：电话套餐、宽带。
- **订阅 (Subscription)**：流媒体、健身房、软件订阅。
- **证件 (Documentation)**：护照、身份证、驾照（费用为 0）。

### 🤖 AI 智能分析
上传文件后点击 "**✨ 使用 AI 分析**"，系统会自动识别并提取：标题、实际月费（排除融资/折扣干扰）、分类及到期时间。
> *注：需在设置中配置 AI API Key。*

### ⚙️ 设置与数据
- **AI 助手**：配置 OpenAI/Gemini/Claude/NVIDIA 密钥。
- **数据管理**：支持一键导出/导入 ZIP 备份。
- **语言**：支持中、英、西实时切换。
