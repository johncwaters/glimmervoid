export type TagTone = 'muted' | 'neutral' | 'accent' | 'warning' | 'failed';
export type TagShape = 'box' | 'pill';

type TagDescriptorInput = {
  text: string;
  tone?: TagTone;
  shape?: TagShape;
};

type TagDescriptor = {
  className: 'ui-tag';
  text: string;
  tone: TagTone;
  shape: TagShape;
};

export function tagDescriptor(input: TagDescriptorInput): TagDescriptor {
  return {
    className: 'ui-tag',
    text: input.text,
    tone: input.tone ?? 'muted',
    shape: input.shape ?? 'box',
  };
}
