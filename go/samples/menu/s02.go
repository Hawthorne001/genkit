// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/firebase/genkit/go/ai"
	"github.com/firebase/genkit/go/genkit"
	"github.com/firebase/genkit/go/plugins/dotprompt"
)

func menu(ctx context.Context, _ *any) ([]*menuItem, error) {
	f, err := os.Open("testdata/menu.json")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var s []*menuItem
	if err := json.NewDecoder(f).Decode(&s); err != nil {
		return nil, err
	}
	return s, nil
}

func setup02(_ context.Context, m *ai.Model) error {
	menuTool := ai.DefineTool("todaysMenu", "Use this tool to retrieve all the items on today's menu", menu)

	dataMenuPrompt, err := dotprompt.Define("s02_dataMenu",
		`You are acting as a helpful AI assistant named Walt that can answer
		 questions about the food available on the menu at Walt's Burgers.

		 Answer this customer's question, in a concise and helpful manner,
		 as long as it is about food on the menu or something harmless like sports.
		 Use the tools available to answer menu questions.
		 DO NOT INVENT ITEMS NOT ON THE MENU.

		 Question:
		 {{question}} ?`,
		dotprompt.Config{
			Model:        m,
			InputSchema:  menuQuestionInputSchema,
			OutputFormat: ai.OutputFormatText,
			Tools:        []ai.Tool{menuTool},
		},
	)
	if err != nil {
		return err
	}

	genkit.DefineFlow("s02_menuQuestion",
		func(ctx context.Context, input *menuQuestionInput) (*answerOutput, error) {
			resp, err := dataMenuPrompt.Generate(ctx,
				&dotprompt.PromptRequest{
					Variables: input,
				},
				nil,
			)
			if err != nil {
				return nil, err
			}

			text, err := resp.Text()
			if err != nil {
				return nil, fmt.Errorf("s02MenuQuestionFlow: %v", err)
			}
			return &answerOutput{Answer: text}, nil
		},
	)

	return nil
}
