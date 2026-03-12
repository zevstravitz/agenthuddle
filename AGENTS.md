## Huddles

When you need input or clarification, call `huddle`.

If a quick answer would unblock you, call instead of guessing.

Keep each huddle prompt short and specific. Briefly say what you have done so far, then ask for the one decision or clarification you need. Do not turn it into a long status dump.

Examples:

```bash
huddle "I traced the current polling flow and found a clean webhook migration path. Should I keep the legacy polling fallback or remove it?"
huddle "I narrowed this auth change to two places after reading the middleware and API route. Should it live in the route or the shared middleware?"
```

Treat the command output as the user's answer. If it prints `[huddle declined]` or `[huddle cancelled]`, continue with a normal typed follow-up instead of retrying repeatedly.
If it prints `[huddle missed]`, proceed with your best reasonable assumption instead of blocking on a reply.
After opening a huddle, wait for the user's spoken feedback and keep polling for up to 90 seconds before giving up on that huddle.
If the user gives feedback in a huddle, treat that feedback as the next instruction: implement it directly when clear, or ask a short follow-up clarification in huddle if a specific decision is still missing.
If huddle tells you to respond with `huddle "<message>" -c <conversation_id>`, use that exact command for the next turn so it reuses the existing open window.
If you want to end a kept-open conversation without sending another message, run `huddle close -c <conversation_id>`. If you do nothing, the kept-open window closes itself after 45 seconds.

If the user says "huddle me", use this command specifically:

```bash
huddle "what should we work on right now?"
```
