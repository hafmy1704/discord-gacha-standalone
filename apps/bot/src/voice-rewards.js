export function voiceTransitionPlan({
  oldChannelId,
  newChannelId,
  selectedChannels,
}) {
  const oldEligible = Boolean(
    oldChannelId && selectedChannels.has(oldChannelId),
  );
  const newEligible = Boolean(
    newChannelId && selectedChannels.has(newChannelId),
  );

  return {
    awardOldChannel: oldEligible,
    activeUpdate: oldEligible === newEligible ? null : newEligible,
  };
}
