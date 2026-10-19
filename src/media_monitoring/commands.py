"""The commands: "uv run youtube <step>" and "uv run telegram <step>" run one step, with the step's own argument if
it takes one (run.sh runs YouTube's in this order). Without a step, they list the steps."""
import importlib
import sys

YOUTUBE = {
    "channels": "refresh every channel's name, handle, description, picture and subscriber count",
    "videos": "find new videos in each channel's uploads list",
    "details": "fetch the details of new videos ([all])",
    "stats": "refresh views and likes ([all|days], every video by default)",
    "comments": "collect new comments ([all|days|unread], every video by default)",
}
TELEGRAM = {
    "channels": "refresh every channel's title, description, photo and subscriber count from its public page",
    "messages": "read every channel's new messages, and keep those with text",
    "history": "read back every channel's older messages, the fewest letters first, until it has 10,000 letters and "
               "100 messages ([letters])",
    "languages": "find every channel's main language from its title, description and messages (CLD2)",
}


def run_step(platform, steps):
    """Run the step the command line names: its module's main() sees the rest of the command line."""
    step = sys.argv[1] if len(sys.argv) > 1 else None
    if step not in steps:
        if step and not step.startswith("-"):
            print(f"{platform}: no step called {step!r}\n", file=sys.stderr)
        print(f"usage: uv run {platform} <step> [argument]\n\nsteps:")
        for name, what in steps.items():
            print(f"  {name:<10} {what}")
        sys.exit(2 if step and not step.startswith("-") else 0)
    sys.argv[:2] = [f"{platform} {step}"]  # what the step's help and errors call it
    importlib.import_module(f"media_monitoring.{platform}.{step}").main()


def youtube():
    run_step("youtube", YOUTUBE)


def telegram():
    run_step("telegram", TELEGRAM)
