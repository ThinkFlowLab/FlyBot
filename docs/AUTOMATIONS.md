# Automations

Open **Automations** in a workspace to create an automation from a template or write your own instructions. You can run it immediately or choose a daily, weekly, monthly, weekdays-only, or one-time schedule. The editor and list show the schedule in its configured time zone.

In **My automations**, select **Upcoming runs** to see enabled schedules in chronological
order, with due runs first. Search within that list and open any automation to edit it or
review its run history. Each row displays the automation's configured time zone.

## Where runs execute

The [FlyBot plugin](../runtime/flybot-workspace-web/features/automations/README.md) stores the automation, schedule, and run history on your account's DS-Bot volume. The scheduler starts when the runtime attaches. It checks enabled schedules and dispatches each eligible run as a native DS-Bot turn, using the runtime's configured model. Workspace switches keep using the same account runtime.

- You can cancel a queued run or stop a running turn. The page asks for confirmation before stopping a run or deleting an automation. It shows **Stopping** while DS-Bot ends a turn. Operations that the turn already completed still take effect.
- If DS-Bot restarts during a turn, history records the run as interrupted or as cancelled if you already requested a stop. Runs that had yet to start can resume when the runtime is ready.
- **Retry** creates a separate run. The original result stays in history. The request uses an idempotency key and the reviewed automation revision, so resubmitting after a lost response returns the same retry.

## Integration

The browser sends the automation template, workspace definition, and run endpoints through the account's DS-Bot adapter. The [automation API dispatch](../runtime/flybot-workspace-web/features/automations/v1.js) defines these routes, including run, cancel, retry, and save result.

Accounts migrated from the old scheduler use an idempotent import of their definitions and run history. The import records the eligible slot at cutover so it cannot run twice. The management service retains the historical data needed to generate an [account import bundle](DSBOT_PLUGIN_ARCHITECTURE.md).
