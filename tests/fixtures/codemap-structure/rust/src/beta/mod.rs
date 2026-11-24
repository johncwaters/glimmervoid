pub fn pong(depth: u32) -> u32 {
    if depth == 0 {
        return 1;
    }
    crate::alpha::ping(depth - 1)
}
