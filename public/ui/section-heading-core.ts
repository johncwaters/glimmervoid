export type SectionHeadingLevel = 2 | 3 | 4 | 'none';
export type SectionHeadingTone = 'muted' | 'strong' | 'waiting';
export type SectionHeadingCount = number | string | null;

const HEADING_TAGS = { 2: 'h2', 3: 'h3', 4: 'h4', none: 'div' } as const;

type SectionHeadingTag = (typeof HEADING_TAGS)[SectionHeadingLevel];

type SectionHeadingCountState = {
  text: string;
  hidden: boolean;
};

type SectionHeadingDescriptorInput = {
  level: SectionHeadingLevel;
  count?: SectionHeadingCount;
  tone?: SectionHeadingTone;
};

type SectionHeadingDescriptor = {
  className: 'ui-section-heading';
  titleTag: SectionHeadingTag;
  titleClassName: 'ui-section-heading-title ui-label';
  countClassName: 'ui-section-heading-count';
  hintClassName: 'ui-section-heading-hint';
  actionsClassName: 'ui-section-heading-actions';
  tone: SectionHeadingTone;
  count: SectionHeadingCountState;
};

export function sectionHeadingCountState(count: SectionHeadingCount | undefined): SectionHeadingCountState {
  const text = count === null || count === undefined ? '' : String(count);
  return { text, hidden: text === '' };
}

export function sectionHeadingDescriptor(input: SectionHeadingDescriptorInput): SectionHeadingDescriptor {
  return {
    className: 'ui-section-heading',
    titleTag: HEADING_TAGS[input.level],
    titleClassName: 'ui-section-heading-title ui-label',
    countClassName: 'ui-section-heading-count',
    hintClassName: 'ui-section-heading-hint',
    actionsClassName: 'ui-section-heading-actions',
    tone: input.tone ?? 'muted',
    count: sectionHeadingCountState(input.count),
  };
}
