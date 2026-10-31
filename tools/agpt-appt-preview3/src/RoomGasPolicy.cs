namespace AGPT.Shared
{
    public static class RoomGasPolicy
    {
        public const string DefaultAgent = GasAgentCatalog.SupportedAgent;
        public const string DefaultSource = "UserConfiguredDefaultHFC227ea";

        public static string Resolve(string explicitValue, bool hasUnresolvedSource)
        {
            if (hasUnresolvedSource) return null;
            if (string.IsNullOrWhiteSpace(explicitValue)) return DefaultAgent;

            return GasAgentCatalog.NormalizeAgent(explicitValue);
        }
    }
}
