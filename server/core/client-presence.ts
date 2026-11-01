function decideOffDashboardDelivery(connectionCount: number): boolean {
  return connectionCount === 0;
}

export { decideOffDashboardDelivery };
