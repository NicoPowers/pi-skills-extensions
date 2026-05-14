---
name: coding-guidelines
description: Small, readable, maintainable changes—one logical problem per change, split mechanical vs behavioral work, match local style, avoid premature abstraction, clear errors/contracts/logs, tests at boundaries, traceability and safe revert. Use when implementing or reviewing code, or when the user wants Linux/kernel-style incremental change discipline.
---

# Coding Guidelines

You are responsible for producing small, readable, maintainable code changes that are easy to review, test, trace, revert, and extend.

Your goal is not to maximize code volume. Your goal is to solve the assigned problem with the smallest safe change while preserving long-term codebase clarity.

For senior-level judgment—when to reject complexity, escalate risk, and own outcomes—use [senior-engineering-stewardship](../senior-engineering-stewardship/SKILL.md) alongside this skill.

## Core Operating Principle

Make the change easy for the next engineer to understand.

A good change should make it obvious:

- What problem was solved
- Why the change was needed
- What behavior changed
- What files were touched
- How the change was verified
- What risks remain
- How to revert it if needed

Prefer boring, explicit, local, well-tested code over clever, abstract, or overly generalized code.

## 1. Solve One Logical Problem Per Change

Each issue, branch, PR, or patch should do one logical thing.

Do not mix unrelated work into the same change.

Avoid combining:

- Feature work
- Bug fixes
- Refactors
- Formatting changes
- Dependency updates
- File moves
- Renames
- Test rewrites
- Configuration changes
- Infrastructure changes

If multiple kinds of work are needed, split them into separate commits or separate follow-up issues.

Good example:

```text
1. refactor: extract sensor sampling into adc_sampler.c
2. fix: correct ADC timeout handling
3. feat: add low-speed detection mode
4. test: add stationary detection regression test
```

Bad example:

```text
feat: improve sensor system
```

where the diff includes renames, formatting, behavior changes, new abstractions, dependency updates, and unrelated cleanup.

## 2. Prefer Small PRs

A PR should be small enough that a reviewer can understand it carefully.

Small changes are easier to:

- Review
- Test
- Debug
- Revert
- Backport
- Bisect
- Explain
- Trust

If the diff is growing large, stop and ask whether the work should be split.

A large feature should usually become a sequence of small, vertically integrated changes rather than one large merge.

## 3. Separate Mechanical Changes From Behavioral Changes

Mechanical changes are changes that should not alter runtime behavior.

Examples:

- Rename a variable
- Move a file
- Extract a helper
- Reformat code
- Convert code style
- Reorganize folders
- Change imports
- Update comments

Behavioral changes alter what the software does.

Examples:

- Change business logic
- Change firmware timing
- Add retries
- Change API response format
- Modify auth behavior
- Change database writes
- Add a new state machine transition
- Change error handling
- Modify AWS infrastructure behavior

Keep these separate.

Good sequence:

```text
Commit 1: move upload validation into a helper function
Commit 2: add new file size validation behavior
Commit 3: add tests for invalid file size
```

Bad sequence:

```text
Commit 1: refactor upload flow and add new validation
```

This makes it hard to tell whether a bug came from the refactor or the behavior change.

## 4. Preserve Local Style

Before editing code, inspect the surrounding files.

Match the existing codebase’s style for:

- Naming
- File organization
- Error handling
- Logging
- Test structure
- Configuration
- Dependency usage
- Comments
- Async patterns
- State management
- API conventions

Do not introduce a new style just because it is personally preferred.

Do not reformat unrelated code.

Do not modernize old code unless the issue explicitly asks for that.

The best change should look like it naturally belongs in the existing codebase.

## 5. Avoid Unnecessary Abstraction

Do not add abstractions unless they solve a real current problem.

Avoid adding:

- Factories
- Managers
- Providers
- Registries
- Plugin systems
- Generic interfaces
- Dependency injection layers
- New service classes
- Configurable frameworks
- Event buses
- Middleware layers
- Utility libraries

unless the current issue clearly requires them.

A new abstraction is justified only when it:

- Removes real duplication
- Isolates a real hardware/platform boundary
- Protects a real integration boundary
- Simplifies current code
- Makes testing materially easier
- Supports multiple current implementations
- Reduces risk in a known near-term change

Do not build abstractions for hypothetical future requirements.

Prefer this:

```text
parseUploadedCsv()
validateCsvRows()
insertValidRows()
```

over this:

```text
CsvProcessingManagerFactoryProvider()
```

unless the codebase already uses that pattern and it is justified.

## 6. Prefer Explicit Code Over Clever Code

Readable code is better than clever code.

Prefer straightforward control flow.

Prefer obvious names.

Prefer direct conditionals.

Prefer clear error paths.

Prefer local reasoning.

Avoid code that requires the reviewer to mentally simulate too much hidden behavior.

Good:

```ts
if (!userId) {
  throw new Error("Missing user ID");
}

const project = await getProjectById(projectId);

if (project.ownerId !== userId) {
  throw new Error("User does not own this project");
}
```

Bad:

```ts
await authorize(ProjectAccess.Owner, ctx);
```

unless `authorize()` is already a clear, well-tested, established project pattern.

## 7. Keep Functions Focused

A function should do one clear thing.

Avoid functions that combine:

- Reading input
- Validating input
- Mutating state
- Calling external services
- Updating UI
- Logging
- Persisting data
- Retrying failures
- Formatting output

Break complex workflows into named steps.

Good:

```text
readSensorFrame()
filterSensorFrame()
estimateSpeed()
publishSpeed()
```

This applies equally to firmware loops, React components, Lambda handlers, Python tools, backend services, etc.

## 8. Make State and Side Effects Obvious

State changes should be easy to locate.

Be especially careful with:

- Global variables
- Static variables
- Singletons
- Caches
- Background tasks
- Timers
- Interrupt handlers
- Database writes
- Message queues
- MQTT topics
- AWS resources
- Auth/session state
- Filesystem writes
- GUI state
- Hidden mutation inside helpers

If a function mutates state, its name and location should make that clear.

Good:

```text
saveDeviceConfig()
updateUserSession()
publishTelemetryMessage()
writeCalibrationToFlash()
```

Bad:

```text
prepare()
handle()
process()
sync()
```

when those functions secretly mutate persistent state.

## 9. Keep Error Handling Local and Understandable

Do not hide important failure behavior behind vague helpers.

Every external boundary should have clear error handling.

Important boundaries include:

- Network requests
- Database queries
- AWS SDK calls
- Filesystem access
- Serial communication
- I2C/SPI/UART/CAN communication
- Sensor reads
- Firmware timing loops
- GUI file uploads
- Auth flows
- Payment or billing operations
- Background jobs
- Message queues

Good error handling should make clear:

- What failed
- Whether the operation can be retried
- Whether state was partially changed
- What the caller should do next
- What should be logged
- What should be shown to the user, if applicable

Avoid swallowing errors unless there is a clear reason.

## 10. Logs Should Be Useful, Not Noisy

Logs should help diagnose real problems.

Good logs include:

- Operation being attempted
- Important IDs
- Error reason
- Retry count
- State transition
- External service involved
- Timing or duration when relevant

Avoid:

- Excessive debug spam
- Logging secrets
- Logging full tokens
- Logging passwords
- Logging private user data
- Logging every loop iteration in firmware unless explicitly debugging
- Leaving temporary print statements in production code

For embedded systems, avoid logs that disrupt timing-sensitive behavior.

For cloud systems, avoid logs that create unnecessary cost or expose sensitive data.

## 11. Keep Tests Close to the Behavior Changed

When behavior changes, add or update tests when practical.

Tests should verify the behavior, not implementation trivia.

Good tests cover:

- The main success path
- Important edge cases
- Failure behavior
- Regression cases
- Boundary conditions
- Permission/auth cases
- Serialization/parsing behavior
- Hardware abstraction behavior when applicable

For embedded work, verification may include:

- Unit tests where possible
- Hardware-in-the-loop test notes
- Serial logs
- Oscilloscope/logic analyzer evidence
- Known-good input/output captures
- Manual test procedure
- Timing measurements
- Power/current measurements

For AWS/full-stack work, verification may include:

- Unit tests
- Integration tests
- Local emulator tests
- Staging deployment
- API request/response examples
- Database migration checks
- IAM permission validation
- Rollback plan

For GUI/internal tools, verification may include:

- Manual workflow test
- Sample input files
- Screenshot evidence
- Error case validation
- Cross-platform check when relevant

## 12. Do Not Add Dependencies Casually

Adding a dependency is a long-term maintenance decision.

Before adding a dependency, consider:

- Is the dependency necessary?
- Is the problem small enough to solve directly?
- Is the dependency actively maintained?
- Is the license acceptable?
- Does it increase bundle size?
- Does it increase firmware size?
- Does it increase cold-start time?
- Does it introduce security risk?
- Does it complicate deployment?
- Does it work in the target runtime?
- Does it work offline if required?
- Does it create supply-chain risk?

Prefer existing project dependencies when reasonable.

Do not add a new dependency for trivial convenience.

## 13. Be Careful With Configuration

Configuration adds complexity.

Do not add new environment variables, feature flags, build flags, Kconfig options, CLI flags, or settings unless needed.

A new configuration option should have:

- A clear name
- A documented default
- A specific purpose
- Validation
- A known owner
- A test or verification path
- A reason it cannot be hardcoded or inferred

Avoid configuration that only exists because the implementation is uncertain.

## 14. Respect Existing Boundaries

Do not blur architectural boundaries without a clear reason.

Examples:

- UI code should not directly know database internals
- Firmware drivers should not know cloud message formats unless intended
- API handlers should not contain large business logic blocks
- Database migration code should not contain application behavior
- Infrastructure code should not hide application behavior
- GUI code should not silently mutate backend state
- Low-level hardware code should not depend on high-level application policy

When crossing a boundary, make the data contract explicit.

## 15. Make Data Contracts Clear

When code passes data between systems, define the shape clearly.

This matters for:

- REST APIs
- WebSocket messages
- MQTT messages
- Serial protocols
- CAN frames
- UWB packets
- CSV files
- JSON configs
- Database rows
- GUI file imports
- AWS event payloads
- Lambda-to-Lambda calls

Data contracts should be:

- Named
- Versioned when needed
- Validated at boundaries
- Tested with representative examples
- Backward-compatible when existing clients depend on them

Avoid silently changing payload shapes.

## 16. Prefer Incremental Migration

When improving old code, avoid big rewrites.

Prefer:

- Add a seam
- Add a test
- Extract one function
- Replace one call path
- Migrate one module
- Keep old and new behavior side-by-side temporarily only when necessary
- Remove dead code after the migration is complete

Do not rewrite a subsystem just to implement a small feature.

## 17. Keep Comments Useful

Comments should explain why something exists, not repeat what the code says.

Good comments explain:

- Hardware constraints
- Timing assumptions
- Protocol quirks
- Safety concerns
- AWS service limitations
- Browser/runtime limitations
- Non-obvious business rules
- Compatibility constraints
- Calibration assumptions
- Workarounds with links to issues

Bad comments:

```ts
// Increment i
i++;
```

Good comments:

```c
// The sensor requires at least 5 ms after wake before the first valid SPI read.
sleep_ms(5);
```

Remove outdated comments when changing related code.

## 18. Maintain Traceability

Every meaningful change should be traceable back to a reason.

A good PR should include:

- Linked issue or task
- Problem statement
- Summary of the solution
- Files changed
- Behavior changed
- Verification performed
- Risks or limitations
- Follow-up work, if any

If a larger cleanup is discovered, do not include it silently.

Create or propose a separate follow-up issue.

## 19. Keep Reverts Safe

A good change should be easy to revert.

Avoid combining unrelated changes that would make reverting dangerous.

Avoid database, firmware, infrastructure, or protocol changes without thinking through rollback.

For risky changes, include:

- Rollback procedure
- Compatibility notes
- Migration notes
- Feature flag plan, if justified
- Staged rollout plan, if applicable

This is especially important for:

- Database migrations
- AWS infrastructure changes
- Firmware OTA updates
- Protocol changes
- Authentication changes
- Billing/payment code
- Device fleet behavior
- Persistent flash/config changes

## 20. Security and Safety Are Part of Simplicity

Simple code is not enough if it is unsafe.

Always consider:

- Input validation
- Auth checks
- Permission boundaries
- Secret handling
- Token handling
- Injection risks
- File path traversal
- Unsafe deserialization
- Race conditions
- Resource exhaustion
- Buffer bounds
- Integer overflow
- Firmware watchdog behavior
- Fail-safe states
- Recovery after partial failure

Do not weaken security or safety to make the code shorter.

## 21. Performance Changes Need Evidence

Do not optimize without a reason.

Before making performance-oriented changes, identify:

- The bottleneck
- The measurement method
- The target improvement
- The tradeoff
- The risk

For embedded systems, this may include:

- CPU load
- ISR duration
- Loop timing
- Heap usage
- Stack usage
- Power draw
- Sampling jitter
- Bus utilization

For cloud/app systems, this may include:

- Latency
- Cold starts
- Memory usage
- Query time
- Bundle size
- API cost
- Concurrency limits
- Database load

Do not add complexity for theoretical performance.

## 22. Agent Behavior Rules

When working as a coding agent:

1. Read the issue carefully.
2. Identify the smallest safe change.
3. Inspect nearby code before editing.
4. Match existing patterns.
5. Avoid unrelated cleanup.
6. Avoid new abstractions unless clearly justified.
7. Avoid new dependencies unless clearly justified.
8. Separate mechanical changes from behavior changes.
9. Keep the diff small.
10. Add or update tests when practical.
11. Run relevant checks when possible.
12. Report exactly what changed and how it was verified.
13. If unrelated problems are found, mention them as follow-up issues instead of fixing them in the current change.

Do not expand the scope without a strong reason.

Do not silently fix unrelated issues.

Do not rewrite working code unless the task requires it.

Do not optimize, abstract, or generalize prematurely.

## 23. Required PR Summary Format

Every completed change should include a summary like this:

```markdown
## Summary

- Changed:
- Why:
- Behavior impact:
- Files touched:

## Verification

- [ ] Unit tests:
- [ ] Integration tests:
- [ ] Manual test:
- [ ] Build/typecheck/lint:
- [ ] Hardware/staging verification, if applicable:

## Risk

- Risk level:
- Rollback plan:
- Follow-up issues:
```

If a section does not apply, write `N/A` and briefly explain why.

## 24. Stop Conditions

Stop and ask for direction, or create a follow-up issue, when:

- The issue requires a much larger change than expected
- The requested fix conflicts with existing architecture
- The change would require a new dependency
- The change would require a database migration
- The change would alter public APIs
- The change would alter firmware protocols
- The change would affect production infrastructure
- The change would weaken security
- The change would require unclear product decisions
- The current code appears to have a deeper unrelated defect

Do not make high-impact decisions silently.

## 25. Definition of a Good Change

A good change is:

- Small
- Focused
- Readable
- Tested or verified
- Easy to review
- Easy to explain
- Easy to trace
- Easy to revert
- Consistent with local code
- Free of unrelated cleanup
- Free of unnecessary abstraction
- Safe for the system it touches

The best change is often the one that solves the problem without making the codebase feel bigger.
