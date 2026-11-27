export type DisclosureMarker = 'chevron' | 'plus';

type DisclosureDescriptorInput = {
  marker?: DisclosureMarker;
  open?: boolean;
};

type DisclosureDescriptor = {
  className: 'ui-disclosure';
  summaryClassName: 'ui-disclosure-summary';
  markerClassName: 'ui-disclosure-marker';
  bodyClassName: 'ui-disclosure-body';
  marker: DisclosureMarker;
  open: boolean;
};

type DetailsBlockDescriptor = {
  summary: 'Show details';
  bodyClassName: 'ui-details-block-text';
  text: string;
};

export function disclosureDescriptor(input: DisclosureDescriptorInput = {}): DisclosureDescriptor {
  return {
    className: 'ui-disclosure',
    summaryClassName: 'ui-disclosure-summary',
    markerClassName: 'ui-disclosure-marker',
    bodyClassName: 'ui-disclosure-body',
    marker: input.marker ?? 'plus',
    open: input.open ?? false,
  };
}

export function detailsBlockDescriptor(text: string): DetailsBlockDescriptor {
  return {
    summary: 'Show details',
    bodyClassName: 'ui-details-block-text',
    text,
  };
}
