# Build the Windows Desktop Application

The project builds a standalone Electron installer containing the review interface, seed database, source PDFs, and packaged Python PDF worker.

## GitHub Actions build

1. Create an empty repository and upload the contents of this folder as the repository root.
2. Open the repository's **Actions** tab.
3. Select **Build Windows Desktop App**.
4. Choose **Run workflow**.
5. Download the `QuestionBankBuilder-Windows-x64` artifact when the run completes.
6. Run `QuestionBankBuilderSetup.exe` on Windows.

The workflow installs the pinned Electron and Electron Forge versions, packages the PDF worker with PyInstaller, and creates the Windows installer.

## Local Windows build

Install Node.js 24 and Python 3.12, then run in PowerShell:

```powershell
npm install
python -m pip install -r python/requirements.txt pyinstaller==6.16.0
npm run worker:build
npm run make -- --platform win32 --arch x64
```

The installer is generated under `out\make`.

## Application data

The installed app creates its working data below the Electron user-data directory. It maintains:

- `question_bank.sqlite3`
- `sources\`
- `sources\intake\`
- `backups\`

The database and source PDFs are seeded only on first launch. Later launches reuse the existing files. Ten rolling backups are retained.

## Current milestone

Implemented:

- standalone desktop window with no user-facing localhost address
- persistent SQLite storage and first-run data seeding
- rolling and manual database backups
- question review, correction, QA, revision history, approval, and export
- native question/answer file selection
- offline PDF validation and managed intake staging
- Windows installer automation

Next processing module:

- generalized question segmentation and normalization for newly staged PDFs
- answer-key alignment for newly staged batches
- diagram and equation crop association
- optional local model integration for classification, solutions, tags, and difficulty

