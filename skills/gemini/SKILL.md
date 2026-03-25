---
name: gemini
description: Invoke Gemini directly for multimodal tasks, image analysis, code review, or getting a second opinion. Use "/gemini" followed by your request.
user-invocable: true
argument-hint: <prompt or instruction>
allowed-tools:
  - Bash(PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH" gemini *)
  - Read
---

# /gemini — Gemini CLI Bridge

Directly invoke Google Gemini for tasks where its capabilities complement Claude's.

## When to use

- Image/screenshot analysis (Gemini's multimodal strength)
- Getting a second opinion on code or analysis
- Long document summarization
- Any task where the user explicitly asks for Gemini

## How to execute

Run the gemini CLI with the user's request:

```bash
PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH" gemini --approval-mode yolo -p "<user's prompt>" --model=gemini-3-flash-preview
```

For image analysis, reference the file path in the prompt:

```bash
PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH" gemini --approval-mode yolo -p "Analyze this image at /path/to/image.png: <question>" --model=gemini-3-flash-preview
```

## Output

Return Gemini's response to the user. Strip the "YOLO mode is enabled" and "Loaded cached credentials" lines from output.
