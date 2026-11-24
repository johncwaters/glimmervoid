from alpha.ping import ping


def pong(depth: int) -> int:
    return 1 if depth <= 0 else ping(depth - 1)
