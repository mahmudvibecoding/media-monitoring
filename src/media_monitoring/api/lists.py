"""What the API's lists share: how many items to a page, how far the pages go, and how a search finds its text"""

PAGE_SIZE = 50  # items to a page
LAST_PAGE = 10_000  # the furthest a page may be, so that skipping to it stays quick
SEARCH_MAX = 100  # characters


def anywhere(text: str) -> str:
    """A LIKE pattern for the text anywhere in a value: the text's own %, _ and \\ count as themselves"""
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
