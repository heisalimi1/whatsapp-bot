# Session Manager for the WhatsApp bot

Target: `i-07e90b2538d64c784`, Ohio (`us-east-2`). Project: `/home/ec2-user/whatsapp-bot`.

## AWS setup

SSM Agent 3.3.5226.0 is running and enabled, with working outbound HTTPS access to AWS's SSM endpoints. The attached instance profile and role are named **WhatsappBotSSRole** in AWS. The role has **AmazonSSMManagedInstanceCore** and one other managed policy; its permissions were preserved. Browser access and the local AWS CLI connection are working. No EC2 restart or inbound-rule change was needed.

The following Console steps are a setup reference; the instance role is already configured:

1. In **IAM → Roles → Create role**, select **AWS service → EC2**. Attach **AmazonSSMManagedInstanceCore** and create **WhatsAppBotSSMRole**. If an existing instance role has since been attached, add the managed policy to that role instead; retain its other permissions.
2. In **EC2**, select **Ohio / us-east-2**, select the target instance, and choose **Actions → Security → Modify IAM role**. Select the role and choose **Update IAM role**. No instance restart is required.
3. For local browser-based AWS CLI sign-in, the existing IAM user or role needs **SignInLocalDevelopmentAccess**, unless its existing permissions already grant those actions. For an IAM user: **IAM → Users → your sign-in user → Add permissions → Attach policies directly → SignInLocalDevelopmentAccess → Add permissions**. For a role, use **IAM → Roles → your sign-in role → Add permissions → Attach policies**. Keep the other policies. If using IAM Identity Center, use its AWS CLI SSO login instead of `aws login`.
4. If this identity lacks Session Manager access, add the supplied [instance-scoped access policy](../deploy/session-manager-access.policy.json) as an inline policy named **WhatsAppBotSessionManagerAccess**. Existing administrators generally already have these permissions. Do not add broad SSM administrative permissions just to connect to this instance.
5. In **Systems Manager → Fleet Manager / Managed nodes**, check that the instance becomes **Online** in Ohio. **EC2 → instance → Connect → Session Manager** also provides a browser-based access check.

References: [instance permissions](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-instance-permissions.html), [AWS CLI browser sign-in](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html), [SSH through Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html).

## Local configuration

AWS CLI and the Session Manager plugin are installed for this Windows user. Their signed packages were verified. VS Code Remote SSH is installed.

Personal configuration lives outside Git:

- `%USERPROFILE%\.aws\config` and AWS's temporary login cache: profile **whatsapp-bot**, region **us-east-2**.
- `%LOCALAPPDATA%\WhatsAppBot\ssm-tools\config.json`: executable locations and instance settings; no credentials.
- `%LOCALAPPDATA%\WhatsAppBot\ssm-tools\ssm-proxy.ps1`: Session Manager proxy.
- `%USERPROFILE%\.ssh\config`: alias **whatsapp-bot-ssm**.

The SSH alias reuses the existing private key, validates the existing server host key, and starts `AWS-StartSSHSession`. It connects to the instance ID rather than its public IP. Private keys and temporary AWS credentials must stay outside the repository.

## VS Code workflow

Use **Terminal → Run Task**:

1. **AWS: Sign in** — finish AWS sign-in in the browser. No access keys are needed. Temporary credentials expire; repeat this task when necessary.
2. **AWS: Verify Session Manager** — checks AWS authentication, SSM Online status, an SSH connection through SSM, PM2 and the local dashboard. It does not restart the bot or change inbound rules.
3. **AWS: Open EC2 terminal through SSM** — opens an `ec2-user` shell in the VS Code terminal.
4. **AWS: Verify deployment access (no restart)** — checks the server checkout, GitHub fetch access, production dependencies, PM2, the dashboard and permission to write private backups. It never stops or restarts the bot.
5. **AWS: Deploy pushed main through SSM (restarts bot)** — deploys commits already pushed to GitHub main. It refuses a dirty server checkout, divergent history or a release that tracks private storage, backs up private production files outside Git, installs production dependencies, verifies preservation, briefly restarts the existing PM2 process and checks the dashboard. If main is already deployed, it does not restart PM2. This task never reboots the EC2 instance. Run it only when you intend to deploy.

Optional: **Remote-SSH: Connect to Host → whatsapp-bot-ssm**, then open `/home/ec2-user/whatsapp-bot`. Remote SSH installs a VS Code server on EC2, which uses additional memory; local tasks provide deployment and terminal access without that server on this small instance.

## Rules and test status

Both **AWS: Verify Session Manager** and **AWS: Verify deployment access (no restart)** have succeeded. You can now remove the public inbound TCP 22 rule from this instance's security group. Keep HTTPS 443 and HTTP 80 for the website and certificate renewal. Keep the server's SSH service running: the SSM tunnel connects to it internally. No security-group rules were changed by these tasks. Session Manager needs outbound HTTPS, not new inbound ports. No new VPC endpoints, instances, public SSH exposure or reboot was required.

Verified on **2026-10-09**:

- Browser AWS CLI sign-in completed; the instance reports **Online** in Systems Manager.
- SSH through `AWS-StartSSHSession` succeeded with the existing key and strict server host-key checking. No direct public SSH fallback was used.
- The deployment preflight passed: clean main checkout, GitHub fetch, installed production dependencies, private backup write access, PM2 and local dashboard checks.
- The deployment task found server and GitHub main already at **a6722f6eaffa**, so it correctly skipped the update and restart. This tested the deployment task without installing a new release.
- PM2 remained **online**, with the same PID **110438** before and after all tests; Node is **v22.23.3**.
- Local `/login` and public `https://16.59.134.38/login` returned **HTTP 200**; public TLS validation succeeded.
- The production environment file, authentication database, existing account and WhatsApp authentication directories remain present. The account is recorded as connected. No private production files were modified or deleted by the setup.
- JavaScript, Bash and task/policy JSON syntax checks passed. The existing unrelated local edits were left untouched.

AWS records session API activity in CloudTrail. SSH over Session Manager does not provide command transcript logging; SSH encrypts the stream inside the TLS tunnel. See the AWS SSH reference above.
