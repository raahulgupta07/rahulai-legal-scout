"""
LLM-based grader for evaluating Scout responses.

Uses a small, fast model to evaluate if the agent's response correctly
answers the user's question given the expected results.
"""

from dataclasses import dataclass

import os
from openai import OpenAI


@dataclass
class GradeResult:
    """Result of LLM grading."""

    passed: bool
    reasoning: str
    score: float  # 0.0 to 1.0


GRADER_SYSTEM_PROMPT = """\
You are an evaluation grader for Legal Scout, an agent that answers Myanmar corporate-law questions
and generates legal documents from Word templates and a company register. Your job is to determine
if the agent's response correctly answers the user's question.

You will be given:
1. The user's question
2. The agent's response
3. Expected values that should appear in the answer
4. Optionally, the expected source document path

Evaluate based on:
- Factual correctness: Does the response contain the correct information?
- Completeness: Does it answer the question asked?
- Source citation: Does it reference the correct document?
- No hallucinations: The response should not include made-up information.

Be lenient about:
- Extra context or insights (the agent may provide more than asked)
- Different phrasing or formatting
- Partial path matches (e.g., "employee-handbook.md" matches full path)
- Additional citations beyond the expected one

Respond in this exact format:
SCORE: [0.0-1.0]
PASSED: [true/false]
REASONING: [brief explanation]
"""


def grade_response(
    question: str,
    response: str,
    expected_values: list[str],
    golden_path: str | None = None,
    model: str = "gpt-5.4-mini",
) -> GradeResult:
    """
    Use an LLM to grade the agent's response.

    Args:
        question: The original question asked
        response: The agent's response text
        expected_values: List of strings that should appear in the response
        golden_path: Optional expected source document path
        model: The model to use for grading

    Returns:
        GradeResult with pass/fail, score, and reasoning
    """
    from app.model_config import OPENROUTER_BASE_URL
    client = OpenAI(
        api_key=os.getenv("OPENROUTER_API_KEY"),
        base_url=OPENROUTER_BASE_URL,
    )

    # Build the expected answer context
    expected_context = f"Expected values to appear: {', '.join(expected_values)}" if expected_values else ""
    if golden_path:
        expected_context += f"\nExpected source document: {golden_path}"

    user_message = f"""\
Question: {question}

Agent Response:
{response}

Expected Answer:
{expected_context}

Grade this response."""

    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": GRADER_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        temperature=0,
        max_tokens=500,
    )

    grader_response = completion.choices[0].message.content or ""
    return _parse_grade_response(grader_response)


def _parse_grade_response(response: str) -> GradeResult:
    """Parse the grader's response into a GradeResult."""
    lines = response.strip().split("\n")

    score = 0.5
    passed = False
    reasoning = "Could not parse grader response"

    for line in lines:
        line = line.strip()
        if line.startswith("SCORE:"):
            try:
                score = float(line.split(":", 1)[1].strip())
            except ValueError:
                pass
        elif line.startswith("PASSED:"):
            passed_str = line.split(":", 1)[1].strip().lower()
            passed = passed_str == "true"
        elif line.startswith("REASONING:"):
            reasoning = line.split(":", 1)[1].strip()

    return GradeResult(passed=passed, reasoning=reasoning, score=score)


def check_source_citation(response: str, golden_path: str) -> tuple[bool, str]:
    """Check if the response cites the expected source document."""
    response_lower = response.lower()

    # Check for the full path or filename
    if golden_path.lower() in response_lower:
        return True, f"Found full path: {golden_path}"

    # Check for just the filename
    filename = golden_path.split("/")[-1]
    if filename.lower() in response_lower:
        return True, f"Found filename: {filename}"

    # Check for path segments (e.g., "runbooks/deployment")
    parts = golden_path.split("/")
    if len(parts) >= 2:
        partial = "/".join(parts[-2:])
        if partial.lower() in response_lower:
            return True, f"Found partial path: {partial}"

    return False, f"Expected citation: {golden_path}"
