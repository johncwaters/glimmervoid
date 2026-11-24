pub fn ping(depth: u32) -> u32 {
    if depth == 0 {
        return 0;
    }
    crate::beta::pong(depth - 1)
}
