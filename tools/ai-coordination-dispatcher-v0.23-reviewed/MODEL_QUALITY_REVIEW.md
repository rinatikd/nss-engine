# Local model quality review — 28.10.2026

Observed real CI 40564442377 returned an incorrect capacity (0.864 decimalGB) and a reviewer REJECT; the persisted state was REJECTED. Inference, model response transport and rejection handling completed. The application did not falsely accept that result. The reviewer rationale also contained confused numeric/unit claims, so this is not sufficient evidence of reliable independent math review.

Source finding: OllamaAgent supplied only num_predict. Both executor and reviewer left temperature/seed at runtime defaults. This permits sampling variation between otherwise comparable runs. A loopback HTTP regression reproduced the missing fields before the patch.

Minimal change: explicitly send temperature0 and seed0 for both roles; record generation_options in each attempt and include them in the fixed synthetic CI observation. Prompts, decisions, review schema, arithmetic validator, timeout and model choices are unchanged. The fixture test establishes the outbound payload and metadata only. It does not establish real deterministic inference or math accuracy; hardware/runtime/model changes can still change output.

Release requirements: keep strict final arithmetic/APPROVE checks; report failed semantic validation without calling the transport broken or passing the release. Run one meaningful actual-model check after the changed sampling settings. If the3B writer still fails, a separately justified7B writer is an option (same7B weights with independent contexts can remain reviewer); record the selected role model/digest/settings. Do not rerun unchanged random samples until green, modify a verdict, erase recommendations, or weaken validators.

A single correct sample never guarantees general calculation ability. Engineering calculations need independently verifiable inputs/formulas and deterministic checks where available. Paid API remains forbidden; no actual model or paid request was performed by this review.
