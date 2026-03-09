---
description: Commit the current stage with a descriptive message
---

1. Check git status to see what has changed:
```
git status --short
```

2. Review the changes and compose a descriptive commit message summarizing what was modified. The message should be concise but informative.

3. Stage all changes and commit:
```
git add -A; git commit -m "<descriptive commit message based on the changes>"
```

4. Verify the commit was created:
```
git log -1 --oneline
```

5. Report the commit hash and summary to the user.
