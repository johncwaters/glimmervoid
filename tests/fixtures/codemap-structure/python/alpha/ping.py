from beta.pong import pong


def ping(depth: int) -> int:
    return 0 if depth <= 0 else pong(depth - 1)
