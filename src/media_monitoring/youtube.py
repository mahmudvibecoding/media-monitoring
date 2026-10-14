"""InnerTube, the API behind YouTube's own website: where it is, the client we present, and one request through
one proxy. The collectors ask it for channels, uploads lists, video pages, counts and comments."""
API = "https://www.youtube.com/youtubei/v1/"
CONTEXT = {"client": {"clientName": "WEB", "clientVersion": "2.20251001.01.00", "hl": "en", "gl": "US"}}
TIMEOUT = 5  # seconds; a proxy that hasn't answered by then has failed
# What proxies are tested with (see pool.py): a channel and a video that have been up for years
TEST_CHANNEL = "UCVPst_iSyaVYpuOP4ogRhlw"  # KunUZ
TEST_VIDEO = "dQw4w9WgXcQ"  # up since 2009


async def call(session, proxy, method, url, **kwargs):
    """One HTTP request through one proxy. Returns (problem, response): problem is None when YouTube
    answered normally, else "broken" (the proxy failed), "blocked" (403 or 429), "bad request" (400) or
    "youtube error" (500 and up), and response is None."""
    try:
        response = await session.request(method, url, proxy=proxy, timeout=TIMEOUT, **kwargs)
    except Exception:
        return "broken", None  # the proxy didn't get us an answer
    if response.status_code == 400:
        # YouTube's own 400 is a JSON error; any other came from the proxy (we don't check certificates)
        try:
            from_youtube = response.json()["error"]["code"] == 400
        except Exception:
            from_youtube = False
        return ("bad request" if from_youtube else "broken"), None
    if response.status_code in (403, 429):
        return "blocked", None
    if response.status_code >= 500:
        return "youtube error", None
    return None, response
