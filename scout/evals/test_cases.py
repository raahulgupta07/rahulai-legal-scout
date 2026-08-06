"""
Test cases for evaluating Scout — Myanmar corporate-law document automation.

Each test case includes:
- question: The natural language question to ask
- expected_strings: Strings that should appear in the response (for backward compatibility)
- category: Test category for filtering
- golden_path: Optional file path where the answer should be found

When golden_path is provided, the evaluation will:
1. Verify the agent cited the correct source document
2. Factor source citation into the pass/fail decision

golden_path is omitted throughout: this agent answers from the templates /
companies / knowledge tables, not from a checked-in document tree, so there is
no on-disk path to cite. Company names below are fictional — never use a real
client's company in a suite that gets shared or logged.
"""

from dataclasses import dataclass


@dataclass
class TestCase:
    """A test case for evaluating Scout."""

    question: str
    expected_strings: list[str]
    category: str
    golden_path: str | None = None
    # Expected result for simple queries (e.g., a specific value)
    expected_result: str | None = None


# Test cases organized by category
TEST_CASES: list[TestCase] = [
    # Template selection — mapping a plain-English request to the right template
    TestCase(
        question="Which template do I use to record an annual general meeting?",
        expected_strings=["Annual General Meeting Minutes"],
        category="template_selection",
    ),
    TestCase(
        question="I need to appoint a new director who is not a group member. Which document?",
        expected_strings=["Director Consent", "Non-Group"],
        category="template_selection",
    ),
    TestCase(
        question="What templates do you have available?",
        expected_strings=["template"],
        category="template_selection",
    ),
    TestCase(
        question="We are registering a brand new company. Which documents do I need?",
        expected_strings=["consent"],
        category="setup_flow",
        # Must show ONLY the new-company-setup group, not the whole template list
    ),
    TestCase(
        question="List the new company setup templates.",
        expected_strings=["setup"],
        category="setup_flow",
    ),
    # Signing rules — the client-reported defect the legal-skills engine fixes
    TestCase(
        question=(
            "A corporate shareholder is consenting to a new company's incorporation. "
            "Whose directors sign the Corporate Shareholder Consent?"
        ),
        expected_strings=["corporate shareholder", "director"],
        category="signing_rules",
        # Correct answer: the CORPORATE SHAREHOLDER's own directors,
        # never the new company's board.
    ),
    TestCase(
        question=(
            "Golden Lotus Trading Limited is a corporate member of a new company. "
            "Can the new company's own board sign the Corporate Shareholder Consent on its behalf?"
        ),
        expected_strings=["no"],
        category="signing_rules",
    ),
    TestCase(
        question="How does a corporate signatory sign a document differently from an individual?",
        expected_strings=["representative"],
        category="signing_rules",
    ),
    # Company register — data that must be read, never re-asked
    TestCase(
        question="When you generate an AGM, do you ask me for the financial year end date?",
        expected_strings=["register"],
        category="company_register",
        # Financial year end, next financial year end, auditor name and auditor fee
        # all come from the companies table and must NOT be asked again.
    ),
    TestCase(
        question="Where does the auditor name and auditor fee on a generated document come from?",
        expected_strings=["compan"],
        category="company_register",
    ),
    TestCase(
        question="What company information do you hold for each company?",
        expected_strings=["director", "shareholder", "registered office"],
        category="company_register",
    ),
    TestCase(
        question="Which companies can I generate documents for?",
        expected_strings=["compan"],
        category="company_register",
    ),
    # Legal knowledge — Myanmar corporate law and DICA
    TestCase(
        question="What is DICA?",
        expected_strings=["Myanmar", "compan"],
        category="legal_knowledge",
    ),
    TestCase(
        question="Which law governs company registration in Myanmar?",
        expected_strings=["Myanmar Companies Law", "2017"],
        category="legal_knowledge",
    ),
    TestCase(
        question="When is a Myanmar annual return due?",
        expected_strings=["annual return"],
        category="legal_knowledge",
    ),
    # Interaction contract — cards, never typed yes/no or lettered prose lists
    TestCase(
        question="Create an AGM.",
        expected_strings=["compan"],
        category="interaction",
        # No company given: the agent must ask which company via a question card,
        # and must never instruct the user to "reply yes/no" or pick "a) b) c)".
    ),
    TestCase(
        question="Generate a document.",
        expected_strings=["?"],
        category="interaction",
    ),
    # Edge cases — out of scope, unknown company, missing data
    TestCase(
        question="What is the weather in Yangon tomorrow?",
        expected_strings=["legal"],
        category="edge_case",
        # Out of scope: decline and steer back to legal documents, do not answer.
    ),
    TestCase(
        question="Generate AGM minutes for Nonexistent Placeholder Company Limited.",
        expected_strings=["not"],
        category="edge_case",
        # No such company in the register — say so rather than inventing data.
    ),
    TestCase(
        question="What are the tax implications of my share transfer?",
        expected_strings=["lawyer"],
        category="edge_case",
        # Legal advice must carry the qualified-lawyer disclaimer.
    ),
]

# Categories for filtering
CATEGORIES = [
    "template_selection",
    "setup_flow",
    "signing_rules",
    "company_register",
    "legal_knowledge",
    "interaction",
    "edge_case",
]


# Backward compatibility: export as tuples for any code expecting the old format
def get_legacy_test_cases() -> list[tuple[str, list[str], str]]:
    """Get test cases in legacy tuple format (question, expected_strings, category)."""
    return [(tc.question, tc.expected_strings, tc.category) for tc in TEST_CASES]
