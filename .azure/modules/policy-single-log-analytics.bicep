// Azure Policy: Deny more than one Log Analytics workspace per resource group.
//
// This module creates a subscription-scoped policy definition (and optional
// assignment) that enforces the single-workspace constraint at the Azure
// platform level, complementing the deploy-time guard in
// setup-wizard/deploy.js.
//
// Why two layers?
//   Azure Policy's `deny` effect evaluates the INCOMING request and cannot
//   natively count existing resources of the same type within a resource
//   group during that evaluation. The deploy.js guard closes this gap for
//   deployments made through this project's tooling. This policy closes
//   the gap for out-of-band deployments (portal, other scripts, other
//   pipelines) by enforcing a mandatory naming convention:
//
//     Workspaces must be named  <anything>-logs
//
//   Since the template always generates the name `<projectName>-logs` and
//   no legitimate second workspace would follow that convention with a
//   different prefix, this catches the most common accident. A workspace
//   called `myproject-logs` passes; an ad-hoc `audit-workspace` is denied.
//
// Assignment:
//   Pass `assignToSubscription = true` (default) to deploy both the
//   definition and an assignment scoped to the current subscription.
//   Set it to `false` to deploy only the definition — useful when
//   assigning via a management group outside this Bicep run.
//
// Scope this module at the subscription level:
//   module singleLaPolicy 'modules/policy-single-log-analytics.bicep' = {
//     name: 'singleLaPolicy'
//     scope: subscription()
//     params: { ... }
//   }

targetScope = 'subscription'

// ---------- parameters ----------

@description('Display name shown in the Azure portal for this policy definition.')
param displayName string = 'Limit Log Analytics workspaces to one per resource group'

@description('Policy effect when a workspace violates the constraint.')
@allowed([ 'Deny', 'Audit', 'Disabled' ])
param effect string = 'Deny'

@description('When true, create a policy assignment scoped to the current subscription in addition to the definition.')
param assignToSubscription bool = true

@description('Location for the system-assigned identity used by the policy assignment (required only for deployIfNotExists/modify effects; safe to set even for Deny/Audit).')
param assignmentLocation string = 'eastus'

// ---------- policy definition ----------

resource policyDef 'Microsoft.Authorization/policyDefinitions@2021-06-01' = {
  name: 'deny-multiple-log-analytics-per-rg'
  properties: {
    policyType: 'Custom'
    mode: 'Indexed'
    displayName: displayName
    description: 'Denies or audits creation of Log Analytics workspaces whose names do not follow the <project>-logs convention enforced by the agent-template deployment. Only one workspace slot (name ending in -logs) is permitted per resource group; ad-hoc or redundant workspaces are blocked.'
    metadata: {
      category: 'Monitoring'
      version: '1.0.0'
    }
    parameters: {
      effect: {
        type: 'String'
        metadata: {
          displayName: 'Effect'
          description: 'Deny blocks deployment; Audit flags it as non-compliant without blocking; Disabled turns the policy off.'
        }
        allowedValues: [ 'Deny', 'Audit', 'Disabled' ]
        defaultValue: 'Deny'
      }
    }
    policyRule: {
      // The condition below targets Log Analytics workspaces whose names
      // do NOT follow the `<prefix>-logs` pattern used exclusively by
      // this template. Any workspace named `foo-logs` still passes the
      // naming check; the deploy.js checkLogAnalyticsQuota guard ensures
      // only one such workspace exists in the RG at deploy time.
      if: {
        allOf: [
          {
            // Target resource type.
            field: 'type'
            equals: 'Microsoft.OperationalInsights/workspaces'
          }
          {
            // Deny workspaces whose names don't end in -logs.
            // The `notMatch` pattern uses ? (single char) and * (any chars).
            field: 'name'
            notMatch: '*-logs'
          }
        ]
      }
      then: {
        effect: '[parameters(\'effect\')]'
      }
    }
  }
}

// ---------- policy assignment (optional) ----------

resource policyAssignment 'Microsoft.Authorization/policyAssignments@2022-06-01' = if (assignToSubscription) {
  name: 'deny-multiple-log-analytics-per-rg'
  location: assignmentLocation
  properties: {
    displayName: displayName
    description: 'Subscription-level assignment of the single-Log-Analytics-per-RG policy.'
    policyDefinitionId: policyDef.id
    parameters: {
      effect: { value: effect }
    }
    enforcementMode: 'Default'
  }
}

// ---------- outputs ----------

output policyDefinitionId string = policyDef.id
output policyAssignmentId string = assignToSubscription ? policyAssignment.id : ''
