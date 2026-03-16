---
description: Kill both frontend and backend servers and restart them
---

// turbo-all

1. Kill all running Node.js (frontend) processes:
```
Get-Process node | Stop-Process -Force -ErrorAction SilentlyContinue
```

2. Kill all running backend (python app.py) processes:
```
Get-Process python* | Where-Object { $_.CommandLine -like '*backend*app.py*' } | Stop-Process -Force -ErrorAction SilentlyContinue
```

3. Wait a moment for the ports to free up:
```
Start-Sleep -Seconds 1
```

4. Start the backend server (runs in the background of the current window):
```
Start-Process -NoNewWindow -FilePath ".venv\Scripts\python.exe" -ArgumentList "backend\app.py"
```

5. Start the frontend server (runs in the foreground):
```
npm run dev
```
