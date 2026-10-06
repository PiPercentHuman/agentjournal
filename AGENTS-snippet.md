## AgentJournal: pin what you were told, journal what you did, sleep when your head is full

For any long job, keep two files in `.agentjournal/` in the working directory:

1. **PIN** - `.agentjournal/PINNED.md`: every instruction the user gives, copied word for word and numbered, written
   before you start and added to when instructions change. Never summarise, reword or delete a pin.
2. **JOURNAL** - `.agentjournal/JOURNAL.md`: after every action, append one short line of what you did and what came of it
   (not what you read). Anything a pin asks you to track goes on the line where it changes, as the items
   themselves (`files changed so far: billing.ts, users.ts`). Never rewrite earlier lines.
3. **SLEEP** - when your context is long, after any compaction, and at the start of every session: read
   PINNED.md and the end of JOURNAL.md and continue from them; they are the truth, not your recollection. If the journal
   is long, append a fold line restating the state, counted from the journal lines.
4. **Bulk work** - do not read a large body of material in your own context: give each chunk to a fresh worker
   (sub-agent, sub-task or new session) with the pins, and journal the one line it returns.
5. **Before "done"** - check every pin against the output you actually produced (read it back) and recount any
   number from the journal or the output.
