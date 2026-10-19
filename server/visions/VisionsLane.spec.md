# Visions lane

The Visions lane: dispatches a model over editor documents and returns comments and intent over LSP

## entrances
- visions socket: the editor extension streams open documents to the Visions lane over LSP
  handler: createVisionsWiring in visions-wiring.ts
  trust: operator

## invariants
