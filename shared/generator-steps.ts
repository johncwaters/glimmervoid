function drained<Value>(steps: Generator<void, Value>): Value {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export { drained };
