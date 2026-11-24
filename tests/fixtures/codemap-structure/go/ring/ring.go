package ring

func One(depth int) int {
	if depth <= 0 {
		return 0
	}
	return Two(depth - 1)
}

func Two(depth int) int {
	if depth <= 0 {
		return 1
	}
	return Three(depth - 1)
}

func Three(depth int) int {
	if depth <= 0 {
		return 2
	}
	return Four(depth - 1)
}

func Four(depth int) int {
	if depth <= 0 {
		return 3
	}
	return Five(depth - 1)
}

func Five(depth int) int {
	if depth <= 0 {
		return 4
	}
	return Six(depth - 1)
}

func Six(depth int) int {
	if depth <= 0 {
		return 5
	}
	return Seven(depth - 1)
}

func Seven(depth int) int {
	if depth <= 0 {
		return 6
	}
	return Eight(depth - 1)
}

func Eight(depth int) int {
	if depth <= 0 {
		return 7
	}
	return One(depth - 1)
}
