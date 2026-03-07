---
description: Kill the backend server and restart it
---

// turbo-all

1. Kill all running backend (python app.py) processes:
```
Get-Process python* | Where-Object { $_.CommandLine -like '*backend*app.py*' } | Stop-Process -Force
```

2. Wait a moment for the port to free up:
```
Start-Sleep -Seconds 1
```

3. Start the backend server again:
```
.venv\Scripts\python.exe backend\app.py
```
