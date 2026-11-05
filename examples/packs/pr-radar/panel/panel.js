function badge(text, tone) {
  return window.glimmervoid.element('span', tone ? `badge ${tone}` : 'badge', text);
}

function pullRequestRow(pullRequest, badges) {
  const row = window.glimmervoid.element('li', 'pr');
  row.append(window.glimmervoid.element('span', 'title', pullRequest.title || pullRequest.key), ...badges);
  return row;
}

function myPullRequestBadges(pullRequest) {
  const badges = [window.glimmervoid.element('span', 'repo', `${pullRequest.repo}#${pullRequest.number}`)];
  if (pullRequest.isDraft) badges.push(badge('draft'));
  if (pullRequest.checks === 'FAILURE' || pullRequest.checks === 'ERROR') badges.push(badge('checks failing', 'bad'));
  if (pullRequest.checks === 'SUCCESS') badges.push(badge('checks green', 'good'));
  if (pullRequest.reviewDecision === 'CHANGES_REQUESTED') badges.push(badge('changes requested', 'bad'));
  if (pullRequest.reviewDecision === 'APPROVED') badges.push(badge('approved', 'good'));
  if (pullRequest.unresolvedThreads > 0) badges.push(badge(`${pullRequest.unresolvedThreads} open threads`));
  return badges;
}

function showList(listId, rows, emptyText) {
  const list = document.getElementById(listId);
  list.replaceChildren(...(rows.length === 0 ? [window.glimmervoid.element('li', 'empty', emptyText)] : rows));
}

window.glimmervoid.subscribe(['my-prs', 'team-reviews', 'theme'], (topic, data) => {
  if (topic === 'theme') window.glimmervoid.applyTheme(data);
  if (topic === 'my-prs') {
    const openPullRequests = data.prs.filter((pullRequest) => pullRequest.state === 'OPEN');
    showList('my-prs', openPullRequests.map((pullRequest) => pullRequestRow(pullRequest, myPullRequestBadges(pullRequest))), 'No open pull requests.');
  }
  if (topic === 'team-reviews') {
    document.getElementById('team-summary').textContent = `${data.ready.length} ready for you, ${data.needsAttention.length} need attention, ${data.inReviewCount} in review, ${data.queuedCount} queued`;
    showList('team-ready', [...data.needsAttention, ...data.ready].map((pullRequest) => pullRequestRow(pullRequest, [window.glimmervoid.element('span', 'repo', pullRequest.author)])), 'Nothing waits on you.');
  }
});
