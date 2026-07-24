// VNet + private DNS foundation for optional private-egress mode.
//
// Two modes:
//   1. Create mode (default, existingVnetName empty): Provisions a new
//      VNet with two subnets:
//       * aca-subnet (delegated to Microsoft.App/environments) — hosts
//         the Container Apps managed environment infrastructure VMs.
//         Min /27 for workload-profiles envs.
//       * pe-subnet — hosts private-endpoint NICs for ACR, AI Search,
//         Storage, Cognitive Services (Voice Live + embeddings), and
//         Cosmos. Private-endpoint network policies are disabled here.
//
//   2. BYON mode (existingVnetName set): Skips VNet and subnet creation
//      and resolves subnet IDs from the existing VNet instead. Use this
//      when deploying into a pre-existing hub/spoke network.
//
// In both modes, private DNS zones are provisioned in the current RG
// and linked to the VNet so that private-endpoint A records resolve
// correctly from within the network.
//
// Subnets in create mode are declared as sibling resources with
// `dependsOn` to serialize creation (parallel subnet creates inside
// the same VNet race and one randomly fails with a "subnet conflict"
// error — this is a well-known Bicep / ARM gotcha).

@description('VNet name. Used only in create mode (existingVnetName empty).')
param vnetName string

@description('Azure region.')
param location string

@description('VNet address space CIDR. Used only in create mode.')
param addressSpace string = '10.20.0.0/16'

@description('Subnet CIDR for the ACA workload-profiles environment. Min /27. Delegated to Microsoft.App/environments. Used only in create mode.')
param acaSubnetCidr string = '10.20.0.0/27'

@description('Subnet CIDR for private endpoint NICs. Used only in create mode.')
param peSubnetCidr string = '10.20.1.0/24'

// ---------- BYON (Bring Your Own Network) ----------
@description('Name of an existing VNet to reuse. When set, VNet and subnet creation is skipped and the existing VNet is used instead (BYON mode).')
param existingVnetName string = ''

@description('Resource group of the existing VNet. Defaults to the current resource group when existingVnetName is set but this is empty.')
param existingVnetResourceGroup string = ''

@description('Name of the existing ACA subnet (must be delegated to Microsoft.App/environments) inside the existing VNet.')
param existingAcaSubnetName string = 'aca-subnet'

@description('Name of the existing private-endpoint subnet (must have privateEndpointNetworkPolicies disabled) inside the existing VNet.')
param existingPeSubnetName string = 'pe-subnet'

// ---------- resolved networking values ----------
var byonMode = !empty(existingVnetName)
var resolvedExistingVnetRg = empty(existingVnetResourceGroup) ? resourceGroup().name : existingVnetResourceGroup

// String-only vars for ID construction. Using strings/params in ternary
// vars is safe — the Bicep InlineDependencyVisitor crash only triggers
// when a var ternary accesses a *ResourceSymbol* property (.id / .name)
// on a conditional resource. Param and string expressions are fine.
var resolvedVnetRg   = byonMode ? resolvedExistingVnetRg : resourceGroup().name
var resolvedVnetName = byonMode ? existingVnetName : vnetName
var resolvedAcaSubnetName = byonMode ? existingAcaSubnetName : 'aca-subnet'
var resolvedPeSubnetName  = byonMode ? existingPeSubnetName  : 'pe-subnet'

// ---------- VNet + subnets (create mode only) ----------

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = if (!byonMode) {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [ addressSpace ]
    }
  }
}

resource acaSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = if (!byonMode) {
  parent: vnet
  name: 'aca-subnet'
  properties: {
    addressPrefix: acaSubnetCidr
    delegations: [
      {
        name: 'aca-env-delegation'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
  }
}

resource peSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = if (!byonMode) {
  parent: vnet
  name: 'pe-subnet'
  properties: {
    addressPrefix: peSubnetCidr
    // PE NICs cannot be created when subnet network policies are on.
    privateEndpointNetworkPolicies: 'Disabled'
  }
  // Serialize subnet creation. Parallel creates inside the same VNet
  // race and one randomly fails with EtagMismatch.
  dependsOn: [ acaSubnet ]
}

// Private DNS zones. Listed in a stable order; outputs reference by
// index. AIServices accounts (kind: 'AIServices', used for Voice Live
// + embeddings) may register A records under any of the three cog /
// openai / services.ai zones depending on the SDK call path — link
// all three to be safe.
var zoneNames = [
  'privatelink.azurecr.io'                  // 0 — ACR
  'privatelink.search.windows.net'          // 1 — AI Search
  'privatelink.blob.core.windows.net'       // 2 — Storage blob
  'privatelink.cognitiveservices.azure.com' // 3 — AIServices (legacy zone)
  'privatelink.openai.azure.com'            // 4 — AIServices (OpenAI compat zone)
  'privatelink.services.ai.azure.com'       // 5 — AIServices (Foundry / forward compat)
  'privatelink.documents.azure.com'         // 6 — Cosmos SQL
]

resource dnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for z in zoneNames: {
  name: z
  location: 'global'
}]

// In BYON mode the link name uses the existing VNet name; in create
// mode it uses the new VNet name. Single unconditional loop so that
// `parent: dnsZones[i]` (an array-index expression) is allowed —
// Bicep BCP240 forbids array-indexed parents on conditional resources.
// The VNet ID is constructed via resourceId() from string vars (safe;
// no ResourceSymbol property access that would trigger the
// InlineDependencyVisitor compiler crash).
resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (z, i) in zoneNames: {
  name: 'link-${resolvedVnetName}'
  parent: dnsZones[i]
  location: 'global'
  properties: {
    virtualNetwork: {
      id: resourceId(resolvedVnetRg, 'Microsoft.Network/virtualNetworks', resolvedVnetName)
    }
    registrationEnabled: false
  }
}]

output vnetId string = resourceId(resolvedVnetRg, 'Microsoft.Network/virtualNetworks', resolvedVnetName)

output acaSubnetId string = resourceId(
  resolvedVnetRg, 'Microsoft.Network/virtualNetworks/subnets', resolvedVnetName, resolvedAcaSubnetName
)

output peSubnetId string = resourceId(
  resolvedVnetRg, 'Microsoft.Network/virtualNetworks/subnets', resolvedVnetName, resolvedPeSubnetName
)

output acrZoneId string = dnsZones[0].id
output searchZoneId string = dnsZones[1].id
output blobZoneId string = dnsZones[2].id
output cogServicesZoneId string = dnsZones[3].id
output openAiZoneId string = dnsZones[4].id
output aiServicesZoneId string = dnsZones[5].id
output cosmosZoneId string = dnsZones[6].id

// Convenience bundles for the AIServices PE (Voice Live, embeddings)
// which we want to register under all three Foundry-family zones.
output aiServicesZoneIds array = [
  dnsZones[3].id
  dnsZones[4].id
  dnsZones[5].id
]
