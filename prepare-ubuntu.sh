#!/usr/bin/env bash
set -euo pipefail
# Only for a new dedicated Ubuntu server. Does not change SSH authentication.
if [ "$(id -u)" -ne 0 ]; then echo 'Run as root on the intended server'; exit 1; fi
apt-get update
apt-get install -y unattended-upgrades ufw
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now unattended-upgrades
printf '%s\n' 'Verify SSH access, then restrict SSH to your administrative IP. Check the provider firewall and IPv6 as well.'
