# Clarification Request for "Message Unavailable" Spam

I understand that the issue is NOT resolved and the app is spamming you with `[Message unavailable due to key change]` messages. I need your confirmation on exactly *how* these messages are appearing so I can pinpoint the exact bug.

Based on your screenshot, I see:
1. You sent 6 messages (`test`, `1`, `2`, `3`, `4`, `5`). They appeared on the **right side** with a single checkmark (`✓`).
2. There are 6 `[Message unavailable due to key change]` messages appearing on the **left side**.

### Please confirm which of the following scenarios is happening:

**Scenario A (The Echo Bug):**
You typed "test" and pressed Enter. *Immediately* (or within a split second), a `[Message unavailable...]` bubble popped up on the **left side**, while your sent message "test" appeared on the **right side**. You did this 6 times, and every single time you hit Enter, a new "unavailable" bubble appeared on the left. The other person (`@aryo2`) was offline the entire time and didn't do anything.

**Scenario B (The Reload/History Bug):**
You typed "test", "1", "2", "3", "4", "5". They all appeared perfectly fine on the right side. Then, you **refreshed/reloaded the page**. When the page finished loading, the 6 messages you previously sent magically reappeared as `[Message unavailable...]` bubbles on the **left side**, while the ones on the right side stayed there (or maybe only the ones on the left appeared?). 

**Scenario C (The Multi-Tab Bug):**
You have GhenApp open in **two different tabs or devices** at the same time. You sent the messages in Tab 1, and the `[Message unavailable...]` bubbles randomly spammed into Tab 2.

---

### Why I'm asking:
If **Scenario A** is happening, it means the server has a critical bug where it is bouncing your own messages back to you like a boomerang, and the app is mistakenly treating them as incoming messages from the other person.
If **Scenario B** is happening, it means the history loader that fetches old messages from the database is severely broken and is mistakenly rendering your own sent messages on the left side as if the other person sent them.

Please let me know which scenario matches what you experienced (or if it's something else entirely)!
